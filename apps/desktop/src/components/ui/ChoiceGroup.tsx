"use client";

import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";

import { Grid } from "./layout";
import styles from "./ChoiceGroup.module.css";

export interface ChoiceGroupOption<T extends string> {
  value: T;
  /** The accessible name and the card's short label — the same words, so they cannot drift. */
  label: string;
  icon: LucideIcon;
}

export interface ChoiceGroupProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly ChoiceGroupOption<T>[];
  /**
   * The group's accessible name. Give exactly one of these — `aria-labelledby` when a caption is
   * already on screen, so the words are not written once for the eye and again for the reader.
   */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  columns?: 1 | 2 | 3 | 4;
  "data-testid"?: string;
}

/**
 * A small set of mutually exclusive choices, shown as icon cards rather than a dropdown.
 *
 * For choices whose shape *is* the information — a bar chart against a pie chart — a list of words
 * behind a closed menu hides the one thing the author is choosing between. The icons make the set
 * readable at a glance, and keeping it a `radiogroup` keeps it operable without a pointer.
 *
 * Selection is drawn as a soft grey face rather than a heavy border, and the group owns no colour
 * of its own (`docs/design-rules.md`: monochrome first, calm surfaces, no accent on wide areas).
 */
export function ChoiceGroup<T extends string>({
  value,
  onChange,
  options,
  columns = 4,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "data-testid": testId,
}: ChoiceGroupProps<T>) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  // Roving tabindex: tabbing into the group lands on the selected option, and the arrow keys move
  // within it. A group whose value matches nothing still has to be reachable, so the first option
  // takes the tab stop — otherwise the whole control is invisible to the keyboard.
  const tabStopIndex = selectedIndex < 0 ? 0 : selectedIndex;

  const select = (index: number) => {
    const option = options[index];
    if (!option) {
      return;
    }
    buttonsRef.current[index]?.focus();
    if (option.value !== value) {
      onChange(option.value);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (options.length === 0) {
      return;
    }
    // A radiogroup moves *and* selects on arrow keys — that is the WAI-ARIA pattern, and it is what
    // makes the choice reachable in one keystroke instead of arrow-then-confirm.
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      select((index + 1) % options.length);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      select((index - 1 + options.length) % options.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      select(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      select(options.length - 1);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      select(index);
    }
  };

  return (
    <Grid
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      // Announced as horizontal (a radiogroup's default) while Up/Down are still answered, so the
      // reading matches the row of cards a sighted user sees.
      aria-orientation="horizontal"
      className={styles.group}
      columns={columns}
      data-testid={testId}
      gap="xs"
      // The group lives on fixed-width floating panels, so collapsing on *viewport* width would key
      // the layout off a measurement that has nothing to do with the space it actually has.
      responsive={false}
      role="radiogroup"
    >
      {options.map((option, index) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className={styles.option}
            data-selected={selected ? "true" : undefined}
            key={option.value}
            onClick={() => select(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              buttonsRef.current[index] = element;
            }}
            role="radio"
            tabIndex={index === tabStopIndex ? 0 : -1}
            type="button"
          >
            <Icon aria-hidden className={styles.icon} size={18} />
            <span className={styles.label}>{option.label}</span>
          </button>
        );
      })}
    </Grid>
  );
}
