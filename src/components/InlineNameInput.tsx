import { useEffect, useRef, useState } from "react";

interface InlineNameInputProps {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  /** Why the typed name can't be used (shown under the box), or `null`. */
  validate?: (value: string) => string | null;
}

/**
 * A focused, auto-selected text input used for both "rename" and "name a newly created item" (VS Code): Enter
 * commits, Escape cancels. A name the rules refuse shows the reason under the box; Enter then does nothing and leaving
 * the box cancels, so the tree is never left half-changed.
 */
export function InlineNameInput({ initialValue, onCommit, onCancel, validate }: InlineNameInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dotIndex = initialValue.lastIndexOf(".");
    input.setSelectionRange(0, dotIndex > 0 ? dotIndex : initialValue.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus only on mount
  }, []);

  const check = (value: string) => {
    const trimmed = value.trim();
    // An empty box is not an error while typing: Enter/leaving it simply creates nothing.
    return trimmed === "" || trimmed === initialValue ? null : (validate?.(trimmed) ?? null);
  };

  return (
    <span className="inline-name">
      <input
        ref={inputRef}
        type="text"
        className={problem === null ? "inline-name-input" : "inline-name-input inline-name-input--invalid"}
        defaultValue={initialValue}
        aria-invalid={problem !== null}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onChange={(event) => {
          setProblem(check(event.currentTarget.value));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const value = event.currentTarget.value;
            const found = check(value);
            setProblem(found);
            if (found === null) onCommit(value.trim());
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={(event) => {
          const value = event.currentTarget.value;
          if (check(value) === null) onCommit(value.trim());
          else onCancel();
        }}
      />
      {problem !== null ? (
        <span className="inline-name__problem" role="alert">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
