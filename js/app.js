// This file is a shim for users who have a cached version of index.html
// that still expects js/app.js to exist. The app has been modularized.
// We force a redirect with a cache-buster query parameter to fetch the new index.html.

console.warn("Cached index.html detected. Redirecting to fetch the latest version...");

if (!window.location.search.includes('nocache')) {
  var url = window.location.origin + window.location.pathname;
  var params = window.location.search ? window.location.search + "&" : "?";
  params += "nocache=" + Date.now();
  window.location.replace(url + params + window.location.hash);
} else {
  document.addEventListener("DOMContentLoaded", function() {
    var root = document.getElementById("root") || document.body;
    root.innerHTML = "<div style='padding:20px; text-align:center; font-family:sans-serif;'>" +
      "<h3>App Update Required</h3>" +
      "<p>We've released a major update, but your browser is aggressively caching the old version.</p>" +
      "<p>Please <strong>clear your browser cache</strong> or do a <strong>Hard Refresh (Ctrl+Shift+R / Cmd+Shift+R)</strong>.</p>" +
      "</div>";
  });
}
