import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";
import "@sigma-studio/editor/styles.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
