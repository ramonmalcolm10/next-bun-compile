/**
 * Health check endpoint. The systemd unit in `systemd/next-app.service`
 * doesn't poll this directly (systemd is process-up-or-down only), but
 * it's used by the GitHub Actions deploy workflow's post-deploy smoke
 * test, and by anything fronting the binary (caddy, nginx, a load
 * balancer) that wants a deeper readiness signal than TCP-accept.
 */
export async function GET() {
  return Response.json({ ok: true, ts: Date.now() });
}
