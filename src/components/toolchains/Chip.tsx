export function Chip({ label, tone }: { label: string; tone: string }) {
  return <span className={`tc-chip tc-chip--${tone}`}>{label}</span>;
}
