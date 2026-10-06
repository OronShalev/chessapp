import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";

import AnalysisStatus from "@analysis/constants/AnalysisStatus";
import useAnalysisProgressStore from "@analysis/stores/AnalysisProgressStore";
import ProgressReporter from "@/components/common/ProgressReporter";

import useAnalyseGame from "@analysis/hooks/useAnalyseGame";

function AnalysisProgress() {
    const { t } = useTranslation("analysis");

    const {
        evaluationProgress,
        analysisStatus,
        analysisError
    } = useAnalysisProgressStore();

    const analyseGame = useAnalyseGame();

    // Attempt to classify generated evaluations once evaluation completes
    useEffect(() => {
        if (analysisStatus != AnalysisStatus.AWAITING_ANALYSIS) return;

        analyseGame();
    }, [analysisStatus]);

    if (analysisStatus == AnalysisStatus.INACTIVE) return null;

    return <ProgressReporter
        progress={evaluationProgress}
        title={t("progressReporter.evaluating")}
        tooltip={t("progressReporter.evaluatingTooltip")}
        error={analysisError}
    />;
}

export default AnalysisProgress;