import { loadOrganizerState, adoptRemotePoll, setAppMode, setView, state } from "./state.js";
import { parseHash } from "./utils.js";
import { organizerShell, render } from "./ui-components.js";
import { Responder } from "./responder.js";
import { Store, sharedMode } from "./github-store.js";
import { app } from "./ui-components.js";

// Make the app globally aware of some state for callbacks (e.g. checkbox)
window.refreshDashboard = () => Responder.refreshDashboard();

async function init(){
  const h = parseHash();
  if(h.poll && !("admin" in h)){
    setAppMode("responder");
    Responder.start(h);
    return;
  }
  setAppMode("organizer");
  await loadOrganizerState();
  organizerShell();

  if(h.poll && ("admin" in h)){
    app().innerHTML = `<div class="loading">Loading poll ${h.poll}…</div>`;
    try{ await adoptRemotePoll(h.poll); }catch(e){}
    setView("results");
    render();
    try{ history.replaceState(null,"",location.pathname+location.search); }catch(e){}
    return;
  }
  render();
}



if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
