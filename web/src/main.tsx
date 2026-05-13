import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import SlicePage from "./pages/Slice";
import JobsPage from "./pages/Jobs";
import PrintersPage from "./pages/Printers";
import LibraryPage from "./pages/Library";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="slice" element={<SlicePage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="printers" element={<PrintersPage />} />
          <Route path="library" element={<LibraryPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
