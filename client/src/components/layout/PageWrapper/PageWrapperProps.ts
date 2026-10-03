import { CSSProperties, ReactNode } from "react";

interface PageWrapperProps {
    children?: ReactNode;
    className?: string;
    style?: CSSProperties;
    contentClassName?: string;
    contentStyle?: CSSProperties;
    footerClassName?: string;
    footerStyle?: CSSProperties;
    showNavigationBar?: boolean;
    showFooter?: boolean;
}

export default PageWrapperProps;