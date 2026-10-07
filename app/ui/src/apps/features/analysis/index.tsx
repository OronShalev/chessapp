import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import PageWrapper from "@/components/layout/PageWrapper";

import * as styles from "./index.module.css";

const Analysis = lazy(() => import("./pages/Analysis"));

import "@/i18n";
import "@/index.css";
import "@/lib/serviceWorker";

const root = ReactDOM.createRoot(
    document.querySelector(".root")!
);

function App() {
    return <BrowserRouter>
        <PageWrapper
            className={styles.wrapper}
            showNavigationBar={false}
            showFooter={false}
        >
            <Routes>
                {/* The web server serves this page at /analysis. In the
                    mobile app, the same page is the webview origin root
                    (/), so both paths must match. */}
                <Route path="/" element={<Analysis/>} />
                <Route path="/analysis" element={<Analysis/>} />
            </Routes>
        </PageWrapper>
    </BrowserRouter>;
}

root.render(<App/>);