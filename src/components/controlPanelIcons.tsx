import type { ReactNode } from "react";

/**
 * Small colored icons for the control panel's side buttons, in the spirit of
 * XAMPP's (wrench, globe, console, folder, help, door). Decorative only — every
 * button carries its own text label.
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="cp__icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ConfigIcon() {
  return (
    <Icon>
      <path
        d="M10.8 1.5a3.6 3.6 0 0 0-3.4 4.8L1.9 11.8a1.4 1.4 0 0 0 2 2l5.5-5.5a3.6 3.6 0 0 0 4.8-3.4l-2 2-2-.6-.6-2z"
        fill="#5b8fd6"
        stroke="#2f5f9e"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </Icon>
  );
}

export function NetstatIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6.3" fill="#4caf50" stroke="#2e7d32" strokeWidth="0.9" />
      <path
        d="M1.9 8h12.2M8 1.7c-2.2 2.4-2.2 10.2 0 12.6M8 1.7c2.2 2.4 2.2 10.2 0 12.6"
        fill="none"
        stroke="#e8f5e9"
        strokeWidth="0.9"
      />
    </Icon>
  );
}

export function ShellIcon() {
  return (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#2b2b2b" stroke="#555" />
      <path d="M4 6l2.2 2L4 10M7.5 10.5h4" fill="none" stroke="#e0e0e0" strokeWidth="1.1" />
    </Icon>
  );
}

export function ExplorerIcon() {
  return (
    <Icon>
      <path
        d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-10.9a1 1 0 0 1-1-1z"
        fill="#f2c14e"
        stroke="#b8860b"
        strokeWidth="0.8"
      />
    </Icon>
  );
}

export function HelpIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6.3" fill="#3d7fd9" stroke="#1f5bb0" strokeWidth="0.9" />
      <path
        d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4"
        fill="none"
        stroke="#fff"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.6" r="0.8" fill="#fff" />
    </Icon>
  );
}

export function QuitIcon() {
  return (
    <Icon>
      <rect x="3" y="1.5" width="9" height="13" rx="0.6" fill="#b5651d" stroke="#7a4210" />
      <circle cx="10" cy="8.2" r="0.8" fill="#f5deb3" />
    </Icon>
  );
}
