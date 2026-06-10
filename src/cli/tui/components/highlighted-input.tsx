import { Box, Text, type CursorPosition, type DOMElement, useCursor } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import stringWidth from "string-width";

import { currentTheme } from "../themes";

function getAbsolutePosition(node: DOMElement): CursorPosition | undefined {
  let currentNode: DOMElement | undefined = node;
  let x = 0;
  let y = 0;

  while (currentNode?.parentNode) {
    const { yogaNode } = currentNode;
    if (!yogaNode) return undefined;

    x += yogaNode.getComputedLeft();
    y += yogaNode.getComputedTop();
    currentNode = currentNode.parentNode;
  }

  return { x, y };
}

export function HighlightedInput({
  value,
  cursorOffset,
  placeholder,
  highlightedCommandName,
}: {
  value: string;
  cursorOffset: number;
  placeholder: string;
  highlightedCommandName?: string | null;
}) {
  const inputRef = useRef<DOMElement>(null);
  const [absolutePosition, setAbsolutePosition] = useState<CursorPosition | undefined>();
  const { setCursorPosition } = useCursor();

  useLayoutEffect(() => {
    const nextPosition = inputRef.current ? getAbsolutePosition(inputRef.current) : undefined;

    setAbsolutePosition((currentPosition) => {
      if (currentPosition?.x === nextPosition?.x && currentPosition?.y === nextPosition?.y) {
        return currentPosition;
      }

      return nextPosition;
    });
  });

  setCursorPosition(
    absolutePosition
      ? {
          x: absolutePosition.x + stringWidth(value.slice(0, cursorOffset)),
          y: absolutePosition.y,
        }
      : undefined,
  );

  if (value.length === 0) {
    return (
      <Box ref={inputRef}>
        <Text dimColor>{placeholder}</Text>
      </Box>
    );
  }

  const highlightLength = highlightedCommandName ? highlightedCommandName.length + 1 : 0;
  const highlightedValue = value.slice(0, highlightLength);
  const restValue = value.slice(highlightLength);

  return (
    <Box ref={inputRef}>
      {highlightedValue ? (
        <Text bold color={currentTheme.colors.primary}>
          {highlightedValue}
        </Text>
      ) : null}
      {restValue ? <Text>{restValue}</Text> : null}
    </Box>
  );
}
