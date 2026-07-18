import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../rankd-app.jsx";
import MarketingPage from "./MarketingPage.jsx";

const path = window.location.pathname;

// Route table:
//   "/"        → public marketing site (home)
//   "/privacy" → public marketing site (Privacy Policy page)
//   "/terms"   → public marketing site (Terms of Service page)
//   "/login"   → App (no currentUser → LoginScreen)
//   "/reset"   → App (recovery token in URL → ResetPasswordScreen)
//   "/invite/" → App (invite token in pathname → InviteScreen)
//   everything else → App (authenticated dashboard or LoginScreen)
const MARKETING_PATHS = new Set(["/", "", "/privacy", "/terms"]);
const isMarketing = MARKETING_PATHS.has(path);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {isMarketing ? <MarketingPage /> : <App />}
  </StrictMode>
);
