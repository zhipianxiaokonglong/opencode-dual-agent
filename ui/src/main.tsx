import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Shell from "./components/Shell";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("未找到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
