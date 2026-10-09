import { useId, useRef } from "react";

export function KneeTabs({ value, onChange, options }: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; panelId?: string }>;
}) {
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="knee-tabs" role="tablist" aria-label="Rodilla a consultar">
      {options.map((option, index) => (
        <button key={option.value} type="button" role="tab" id={`${id}-${option.value}`}
          aria-selected={value === option.value} tabIndex={value === option.value ? 0 : -1}
          aria-controls={option.panelId}
          ref={(element) => { buttons.current[index] = element; }}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % options.length
              : event.key === "ArrowLeft" ? (index - 1 + options.length) % options.length
              : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
            if (next !== null) { event.preventDefault(); onChange(options[next].value); buttons.current[next]?.focus(); }
          }}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
