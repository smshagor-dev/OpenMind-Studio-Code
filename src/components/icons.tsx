import type { ReactNode } from "react";

/**
 * Line icons drawn after VS Code's Codicons (16x16 grid, `currentColor`), so
 * every icon follows the surrounding text color in both themes.
 */
interface IconProps {
  className?: string;
  size?: number;
}

function Svg({ className, size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ?? "codicon"}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ChevronIcon({ expanded, className }: { expanded: boolean } & IconProps) {
  return (
    <Svg className={className ?? (expanded ? "codicon codicon--rotated" : "codicon")}>
      <path d="M6 3.5 10.5 8 6 12.5" strokeWidth="1.2" />
    </Svg>
  );
}

export function ChevronRightSmallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 4.5 10 8l-3.5 3.5" />
    </Svg>
  );
}

/** Activity bar "Explorer" (codicon `files`). */
export function FilesIcon(props: IconProps) {
  return (
    <Svg size={24} {...props}>
      <path d="M9.5 1.5H4.5v10h8V4.5z" strokeWidth="0.9" />
      <path d="M9.5 1.5v3h3" strokeWidth="0.9" />
      <path d="M2.5 4.5v10h7.5" strokeWidth="0.9" />
    </Svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Svg size={24} {...props}>
      <circle cx="8" cy="8" r="2" strokeWidth="0.9" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        strokeWidth="0.9"
      />
      <circle cx="8" cy="8" r="4.4" strokeWidth="0.9" />
    </Svg>
  );
}

export function EllipsisIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function NewFileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 1.5h-6v13h5" />
      <path d="M9.5 1.5l3 3v4" />
      <path d="M9.5 1.5v3h3" />
      <path d="M12.5 10.5v4M10.5 12.5h4" />
    </Svg>
  );
}

export function NewFolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 13.5H1.5v-10h4l1.5 1.5h7.5v4" />
      <path d="M12.5 10.5v4M10.5 12.5h4" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M12 1.8v2.9H9.1" />
    </Svg>
  );
}

export function CollapseAllIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 4.5h9v9h-9z" />
      <path d="M2.5 11.5v-9h9" />
      <path d="M6.5 9h5" />
    </Svg>
  );
}

export function SaveAllIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5h8l2 2v8h-10z" />
      <path d="M5.5 3.5v3h5v-3M5.5 13.5v-4h5v4" />
      <path d="M1.5 5.5v9h9" />
    </Svg>
  );
}

export function CloseAllIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 3.5h9v9h-9z" />
      <path d="M6 6l4 4M10 6l-4 4" />
      <path d="M1.5 5.5v9h9" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.1" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5l3 3 7-7" strokeWidth="1.2" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9.5" cy="6.5" r="4" />
      <path d="M6.6 9.4 2 14" />
    </Svg>
  );
}

export function LayoutSidebarIcon({ right, ...props }: IconProps & { right?: boolean }) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="0.5" />
      {right ? <path d="M10.5 2.5v11" /> : <path d="M5.5 2.5v11M2 3h3v10H2z" fill="currentColor" />}
    </Svg>
  );
}

export function ErrorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </Svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 1.8 14.6 13.5H1.4z" />
      <path d="M8 6v3.5" />
      <circle cx="8" cy="11.4" r="0.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ChromeMinimizeIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function ChromeMaximizeIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
    </svg>
  );
}

export function ChromeRestoreIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
      <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
    </svg>
  );
}

export function ChromeCloseIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M0 0l10 10M10 0 0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
