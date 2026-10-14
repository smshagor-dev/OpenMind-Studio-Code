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

export function PinIcon({ filled, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props}>
      <path
        d="M9.5 1.5 14 6l-2.3 2.3.8 2.3-1.4 1.4-2.6-2.6-3.4 3.4-1.2-1.2 3.4-3.4-2.6-2.6L5.9 4l2.3.8z"
        fill={filled ? "currentColor" : "none"}
      />
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

export function KeyboardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="4" width="13" height="8" rx="1" />
      <path d="M4 6.5h1M7.5 6.5h1M11 6.5h1M4 9.5h8" />
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

export function SourceControlIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="6.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 8.1c0 2-2.5 2.2-6 3" />
    </Svg>
  );
}

export function DebugIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 2.5v11l8-5.5z" />
      <path d="M2 12.5l1.5-1.5M2 4.5l1.5 1.5" />
    </Svg>
  );
}

export function RemoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="3" width="13" height="8" rx="0.8" />
      <path d="M5.5 14h5M8 11v3" />
    </Svg>
  );
}

export function ExtensionsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="6" width="4.5" height="4.5" />
      <rect x="6.5" y="6" width="4.5" height="4.5" />
      <rect x="2" y="10.5" width="4.5" height="4.5" />
      <rect x="9" y="1.5" width="4.5" height="4.5" transform="rotate(20 11.2 3.7)" />
    </Svg>
  );
}

/** A package box: the Dependencies view. */
export function PackageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 1.5l6 3v7l-6 3-6-3v-7z" />
      <path d="M2 4.5l6 3 6-3M8 7.5v7" />
      <path d="M5 3l6 3" />
    </Svg>
  );
}

export function RuntimeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
      <path d="M6.5 6.5h3v3h-3z" />
    </Svg>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2.5" width="12" height="4.5" rx="0.8" />
      <rect x="2" y="9" width="12" height="4.5" rx="0.8" />
      <path d="M4.5 4.75h.01M4.5 11.25h.01" strokeWidth="1.6" />
    </Svg>
  );
}

export function SplitEditorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2.5" width="12" height="11" rx="0.5" />
      <path d="M8 2.5v11" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="0.8" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
    </Svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" />
    </Svg>
  );
}

export function ChevronDownSmallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6l4 4 4-4" strokeWidth="1.2" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8H3M7 4 3 8l4 4" />
    </Svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  );
}

export function LayoutPanelIcon({ visible, ...props }: IconProps & { visible?: boolean }) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="0.5" />
      {visible ? <path d="M2 10h12v3H2z" fill="currentColor" /> : <path d="M1.5 9.5h13" />}
    </Svg>
  );
}

export function NewWindowIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="4.5" width="10" height="9" rx="0.5" />
      <path d="M4.5 4.5v-2h10v9h-3M1.5 7h10" />
    </Svg>
  );
}

export function LayoutSecondaryIcon({ visible, ...props }: IconProps & { visible?: boolean }) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="0.5" />
      {visible ? (
        <path d="M10.5 2.5v11M11 3h3v10h-3z" fill="currentColor" />
      ) : (
        <path d="M10.5 2.5v11" />
      )}
    </Svg>
  );
}

export function StarIcon({ filled, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props}>
      <path
        d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  );
}

export function CloudDownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 11.5h-.8a2.7 2.7 0 0 1-.3-5.4 3.8 3.8 0 0 1 7.3-.9 2.9 2.9 0 0 1 1.6 5.6" />
      <path d="M8 7.5v6M5.8 11.3 8 13.5l2.2-2.2" />
    </Svg>
  );
}

export function VerifiedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M8 1.2l1.6 1.2 2-.1.6 1.9 1.6 1.2-.6 1.9.6 1.9-1.6 1.2-.6 1.9-2-.1L8 14.8l-1.6-1.2-2 .1-.6-1.9-1.6-1.2.6-1.9-.6-1.9 1.6-1.2.6-1.9 2 .1z"
        fill="currentColor"
        stroke="none"
      />
      <path
        d="M5.6 8.1l1.6 1.6 3.2-3.3"
        stroke="var(--verified-check, #ffffff)"
        strokeWidth="1.3"
      />
    </Svg>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 3.5h12L9.5 8.8v4.2l-3 1.5V8.8z" />
    </Svg>
  );
}

/** A chat bubble with a spark: the AI activity bar item. */
export function AiIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 3.5h12v7H8.5L5 13.5v-3H2z" />
      <path d="M8 5.2v3.6M6.2 7h3.6" />
    </Svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="1.5" width="4" height="8" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 009 0M8 12v2.5M5.5 14.5h5" />
    </Svg>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 6.5V3.5a2 2 0 00-4 0v4a2 2 0 003.2 1.6" />
      <path d="M3.5 7.5a4.5 4.5 0 007.2 3.6M12.5 7.5a4.5 4.5 0 01-.3 1.6M8 12v2.5M5.5 14.5h5M2 2l12 12" />
    </Svg>
  );
}

export function HandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 8V3.5a1 1 0 012 0V7M7 7V2.5a1 1 0 012 0V7M9 7V3.5a1 1 0 012 0V9" />
      <path d="M11 6.5a1 1 0 012 0V10a5 5 0 01-5 5h-.5A4.5 4.5 0 013.6 12.5L2.3 9.7a1 1 0 011.7-1L5 10V8" />
    </Svg>
  );
}
