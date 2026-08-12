/**
 * Left-rail webview boot (UX overhaul, P1).
 *
 * ONE bundle serves the three rail views; `body[data-view]` (set by
 * RailViewProvider) picks which one mounts. Each view speaks the standard
 * panel envelope through the control panel's shared dispatch, so the rail
 * reuses the existing contracts rather than inventing a second protocol.
 *
 * SECURITY: rendering happens in the view modules via textContent only - never
 * innerHTML. This entry only routes.
 */

import { startMessaging } from "./railMessaging.js";
import { createRailView, type RailView } from "./views/railViews.js";

function selectedView(): RailView {
  const requested = document.body.dataset["view"];
  return requested === "recents" || requested === "workspaces" ? requested : "tasks";
}

const app = document.getElementById("app");
if (!app) throw new Error("missing #app root");

startMessaging();

const rail = createRailView(selectedView());
app.replaceChildren(rail.root);
rail.start();
