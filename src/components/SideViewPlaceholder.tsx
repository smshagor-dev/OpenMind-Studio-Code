interface SideViewPlaceholderProps {
  heading: string;
  message: string;
  hint?: string;
}

/**
 * The side bar view of a feature that isn't built yet: a plain, honest empty
 * state — no fake data and no controls that would do nothing.
 */
export function SideViewPlaceholder({ heading, message, hint }: SideViewPlaceholderProps) {
  return (
    <div className="side-placeholder">
      <h3 className="side-placeholder__heading">{heading}</h3>
      <p>{message}</p>
      {hint ? <p className="side-placeholder__hint">{hint}</p> : null}
    </div>
  );
}
