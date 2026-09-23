interface IconProps {
  className?: string;
}

export function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={
        expanded
          ? "tree-icon tree-icon--chevron tree-icon--expanded"
          : "tree-icon tree-icon--chevron"
      }
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function FolderIcon({ open, className }: { open: boolean } & IconProps) {
  return (
    <svg
      className={className ?? "tree-icon"}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      {open ? (
        <path
          d="M1.5 4a1 1 0 0 1 1-1h3.6l1.2 1.4H14a1 1 0 0 1 1 1v.6H3.2a1 1 0 0 0-.98.8L1 12.5V4z"
          fill="#dcb67a"
        />
      ) : (
        <path
          d="M1.5 4a1 1 0 0 1 1-1h3.6l1.2 1.4H14a1 1 0 0 1 1 1v7.6a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4z"
          fill="#dcb67a"
        />
      )}
    </svg>
  );
}

export function FileIcon({ color, className }: { color: string } & IconProps) {
  return (
    <svg
      className={className ?? "tree-icon"}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        d="M3.5 1.5h5.6L12.5 5v9a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z"
        fill="#3c3c3c"
        stroke="#6e6e6e"
      />
      <path d="M9 1.5V5h3.3L9 1.5z" fill="#6e6e6e" />
      <rect x="4.5" y="8" width="6" height="1.4" rx="0.3" fill={color} />
    </svg>
  );
}

export function ExplorerActivityIcon(props: IconProps) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M3 5.5A1.5 1.5 0 0 1 4.5 4h5l1.5 2H19.5A1.5 1.5 0 0 1 21 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
