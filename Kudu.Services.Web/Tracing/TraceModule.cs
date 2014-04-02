using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Web;
using Kudu.Contracts.Tracing;
using Kudu.Core.Infrastructure;
using System.IO;
using System.Security.Cryptography;

namespace Kudu.Services.Web.Tracing
{
    public class TraceModule : IHttpModule
    {
        private static readonly DateTime _startDateTime = DateTime.UtcNow;
        private static readonly object _stepKey = new object();
        private static int _traceStartup;
        private static DateTime _lastRequestDateTime;

        private static readonly object _thisLock = new object();
        private static string _host;

        public static TimeSpan UpTime
        {
            get { return DateTime.UtcNow - _startDateTime; }
        }

        public static TimeSpan LastRequestTime
        {
            get { return DateTime.UtcNow - _lastRequestDateTime; }
        }

        public void Init(HttpApplication app)
        {
            app.BeginRequest += OnBeginRequest;
            app.Error += OnError;
            app.EndRequest += OnEndRequest;
        }

        private static void OnBeginRequest(object sender, EventArgs e)
        {
            _lastRequestDateTime = DateTime.UtcNow;

            var httpContext = ((HttpApplication)sender).Context;
            var httpRequest = new HttpRequestWrapper(httpContext.Request);

            // Swap settings, this is done once per host
            // This is a convenient place since it is called on every request
            // and Host header info is available.
            SwapSettings(httpRequest.Headers["HOST"]);

            // HACK: If it's a Razor extension, add a dummy extension to prevent WebPages for blocking it,
            // as we need to serve those files via /vfs
            // Yes, this is an abuse of the trace module
            if (httpRequest.FilePath.IndexOf("vfs/", StringComparison.OrdinalIgnoreCase) >= 0 &&
                (httpRequest.FilePath.EndsWith(".cshtml", StringComparison.OrdinalIgnoreCase) ||
                httpRequest.FilePath.EndsWith(".vbhtml", StringComparison.OrdinalIgnoreCase)))
            {
                httpContext.Server.TransferRequest(httpRequest.FilePath + Constants.DummyRazorExtension);
            }

            // Always trace the startup request.
            ITracer tracer = TraceStartup(httpContext);

            // Skip certain paths
            if (TraceExtensions.ShouldSkipRequest(httpRequest))
            {
                TraceServices.RemoveRequestTracer(httpContext);
                return;
            }

            tracer = tracer ?? TraceServices.CreateRequestTracer(httpContext);

            if (tracer == null || tracer.TraceLevel <= TraceLevel.Off)
            {
                return;
            }

            var attribs = GetTraceAttributes(httpContext);

            AddTraceLevel(httpContext, attribs);

            foreach (string key in httpContext.Request.Headers)
            {
                if (!key.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
                {
                    attribs[key] = httpContext.Request.Headers[key];
                }
            }

            httpContext.Items[_stepKey] = tracer.Step("Incoming Request", attribs);
        }

        private static void OnEndRequest(object sender, EventArgs e)
        {
            var httpContext = ((HttpApplication)sender).Context;
            var tracer = TraceServices.GetRequestTracer(httpContext);

            if (tracer == null || tracer.TraceLevel <= TraceLevel.Off)
            {
                return;
            }

            var attribs = new Dictionary<string, string>
                {
                    { "type", "response" },
                    { "statusCode", httpContext.Response.StatusCode.ToString() },
                    { "statusText", httpContext.Response.StatusDescription }
                };

            if (httpContext.Response.StatusCode >= 400)
            {
                attribs[TraceExtensions.TraceLevelKey] = ((int)TraceLevel.Error).ToString();
            }
            else
            {
                AddTraceLevel(httpContext, attribs);
            }

            // Response.Headers is not supported in Classic mode, so just skip this
            if (HttpRuntime.UsingIntegratedPipeline)
            {
                foreach (string key in httpContext.Response.Headers)
                {
                    attribs[key] = httpContext.Response.Headers[key];
                }
            }

            tracer.Trace("Outgoing response", attribs);

            var requestStep = (IDisposable)httpContext.Items[_stepKey];

            if (requestStep != null)
            {
                requestStep.Dispose();
            }
        }

        private static void OnError(object sender, EventArgs e)
        {
            try
            {
                HttpApplication app = (HttpApplication)sender;
                var httpContext = app.Context;
                var tracer = TraceServices.GetRequestTracer(httpContext);

                if (tracer == null || tracer.TraceLevel <= TraceLevel.Off)
                {
                    return;
                }

                tracer.TraceError(app.Server.GetLastError());
            }
            catch (Exception ex)
            {
                Debug.WriteLine(ex.Message);
            }
        }

        private static void AddTraceLevel(HttpContext httpContext, Dictionary<string, string> attribs)
        {
            if (!httpContext.Request.RawUrl.StartsWith("/logstream", StringComparison.OrdinalIgnoreCase) &&
                !httpContext.Request.RawUrl.StartsWith("/deployments", StringComparison.OrdinalIgnoreCase))
            {
                attribs[TraceExtensions.TraceLevelKey] = ((int)TraceLevel.Info).ToString();
            }
        }

        private static ITracer TraceStartup(HttpContext httpContext)
        {
            ITracer tracer = null;

            // 0 means this is the very first request starting up Kudu
            if (0 == Interlocked.Exchange(ref _traceStartup, 1))
            {
                tracer = TraceServices.CreateRequestTracer(httpContext);

                if (tracer != null && tracer.TraceLevel > TraceLevel.Off)
                {
                    var attribs = GetTraceAttributes(httpContext);

                    // force always trace
                    attribs[TraceExtensions.AlwaysTrace] = "1";

                    // Dump environment variables
                    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
                    {
                        var key = (string)entry.Key;
                        if (key.StartsWith("SCM", StringComparison.OrdinalIgnoreCase))
                        {
                            attribs[key] = (string)entry.Value;
                        }
                    }

                    tracer.Trace("Startup Request", attribs);
                }
            }

            return tracer;
        }

        private static Dictionary<string, string> GetTraceAttributes(HttpContext httpContext)
        {
            var attribs = new Dictionary<string, string>
                {
                    { "url", httpContext.Request.RawUrl },
                    { "method", httpContext.Request.HttpMethod },
                    { "type", "request" },
                    { "instance", InstanceIdUtility.GetShortInstanceId() }
                };

            // Add an attribute containing the process, AppDomain and Thread ids to help debugging
            attribs.Add("pid", String.Join(",",
                Process.GetCurrentProcess().Id,
                AppDomain.CurrentDomain.Id.ToString(),
                System.Threading.Thread.CurrentThread.ManagedThreadId));

            return attribs;
        }

        public static void SwapSettings(string host)
        {
            if (!String.Equals(host, _host, StringComparison.OrdinalIgnoreCase))
            {
                lock (_thisLock)
                {
                    if (!String.Equals(host, _host, StringComparison.OrdinalIgnoreCase))
                    {
                        string rootPath = PathResolver.ResolveRootPath();
                        
                        SwapSettings(host, Path.Combine(rootPath, Constants.SSHKeyPath), "*");
                        SwapSettings(host, Path.Combine(rootPath, Constants.DeploymentCachePath), Constants.DeploySettingsPath);

                        _host = host;
                    }
                }
            }
        }

        public static void SwapSettings(string host, string path, string filter)
        {
            if (FileSystemHelpers.DirectoryExists(path))
            {
                // use just the site name as suffix
                var pattern = String.Format("{0}_{1}", filter, host.Split('.')[0]);
                foreach (var file in FileSystemHelpers.GetFiles(path, pattern))
                {
                    var target = file.Substring(0, file.Length - host.Length - 1);
                    FileSystemHelpers.MoveFile(file, target, overwrite: true);
                }
            }
        }

        public void Dispose()
        {
        }
    }
}