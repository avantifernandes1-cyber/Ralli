import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../rankd-app.jsx";
import MarketingPage from "./MarketingPage.jsx";

const path = window.location.pathname;

// Route table:
//   "/"        → public marketing site
//   "/login"   → App (no currentUser → LoginScreen)
//   "/reset"   → App (recovery token in URL → ResetPasswordScreen)
//   "/invite/" → App (invite token in pathname → InviteScreen)
//   everything else → App (authenticated dashboard or LoginScreen)
const isMarketing = path === "/" || path === "";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {isMarketing ? <MarketingPage /> : <App />}
  </StrictMode>
);
