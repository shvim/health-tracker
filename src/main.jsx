import React from "react";
import { createRoot } from "react-dom/client";
import HealthTracker from "./HealthTracker.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HealthTracker />
  </React.StrictMode>
);
