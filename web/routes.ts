/** Shared by the hosted Worker, local development and static-site acceptance. */
export function viewerAssetPath(path: string): string {
  if (path === "/") return "/index.html";
  if (path === "/enroll" || path === "/install") return "/install.html";
  if (path === "/privacy" || path === "/privacy/") return "/privacy/index.html";
  if (!path.startsWith("/assets/") && !path.includes("."))
    return "/viewer.html";
  return path;
}
