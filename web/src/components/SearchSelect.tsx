import { useState, useRef, useEffect, useMemo } from "react";

interface Option {
  value: string;
  label: string;
  group?: string;
}

interface SearchSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Search...",
  disabled = false,
}: SearchSelectProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? "",
    [options, value],
  );

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.group?.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Group filtered options
  const grouped = useMemo(() => {
    const groups: { group: string; items: Option[] }[] = [];
    let current: { group: string; items: Option[] } | null = null;
    for (const opt of filtered) {
      const g = opt.group ?? "";
      if (!current || current.group !== g) {
        current = { group: g, items: [] };
        groups.push(current);
      }
      current.items.push(opt);
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [filtered]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-idx]");
    const target = items[highlightIndex] as HTMLElement | undefined;
    target?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, open]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (val: string) => {
    onChange(val);
    setQuery("");
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlightIndex]) {
        handleSelect(filtered[highlightIndex].value);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const handleFocus = () => {
    setOpen(true);
    setQuery("");
  };

  return (
    <div className="search-select" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        value={open ? query : selectedLabel}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="search-select-dropdown" ref={listRef}>
          {grouped.map((g) => (
            <div key={g.group}>
              {g.group && (
                <div className="search-select-group">{g.group}</div>
              )}
              {g.items.map((opt) => {
                const flatIdx = filtered.indexOf(opt);
                return (
                  <div
                    key={opt.value}
                    data-idx={flatIdx}
                    className={`search-select-option${flatIdx === highlightIndex ? " highlighted" : ""}${opt.value === value ? " selected" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(opt.value);
                    }}
                    onMouseEnter={() => setHighlightIndex(flatIdx)}
                  >
                    {opt.label}
                  </div>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="search-select-empty">No matches</div>
          )}
        </div>
      )}
      {open && filtered.length === 0 && query && (
        <div className="search-select-dropdown">
          <div className="search-select-empty">No matches</div>
        </div>
      )}
    </div>
  );
}
