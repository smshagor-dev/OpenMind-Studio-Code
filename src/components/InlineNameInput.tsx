import { useEffect, useRef } from "react";

interface InlineNameInputProps {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** A focused, auto-selected text input used for both "rename" and "name a newly created item". */
export function InlineNameInput({ initialValue, onCommit, onCancel }: InlineNameInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    const dotIndex = initialValue.lastIndexOf(".");
    input.setSelectionRange(0, dotIndex > 0 ? dotIndex : initialValue.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus only on mount
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      className="inline-name-input"
      defaultValue={initialValue}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(event.currentTarget.value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => {
        onCommit(event.currentTarget.value.trim());
      }}
    />
  );
}
