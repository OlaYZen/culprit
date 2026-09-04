/**
 * Entry point for the demo build: index.html lists this module before
 * app.js, and module scripts run in document order, so the stand-ins are in
 * place before the dashboard connects. Nothing in app.js knows about it.
 */
import { installDemo } from "./index.js";

installDemo();
