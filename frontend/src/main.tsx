import React from "react";
import ReactDOM from "react-dom/client";
import { Dashboard } from "./pages/Dashboard";
import "./styles.css";

// Make #root fill the full viewport so the sidebar layout works
const root = document.getElementById("root") as HTMLElement;
root.style.minHeight = "100vh";

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);
