import { Fragment, useRef } from "react";

import type { Recents } from "../appHooks";
import { container } from "../services/container";
import type { WorkspaceState } from "../services/workspaceService";
import { EditorGroupView } from "./EditorGroupView";
import { GitBlameViewer } from "./GitBlameViewer";
import { GitDiffViewer } from "./GitDiffViewer";

interface EditorAreaProps {
  state: WorkspaceState;
  ready: boolean;
  rootPath: string | null;
  breadcrumbsVisible: boolean;
  themeKind: string;
  recents: Recents;
}

/** The row of editor groups, with a draggable divider between neighbours. */
export function EditorArea({ state, ...rest }: EditorAreaProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ index: number; x: number; weights: number[]; width: number } | null>(null);

  return (
    <div className="editor-area" ref={rowRef}>
      <GitDiffViewer themeKind={rest.themeKind} />
      <GitBlameViewer />
      {state.groups.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 ? (
            <div
              className="editor-area__sash"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor groups"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  index,
                  x: event.clientX,
                  weights: state.weights,
                  width: rowRef.current?.clientWidth ?? 1,
                };
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (!current) return;
                const delta = (event.clientX - current.x) / current.width;
                const weights = [...current.weights];
                weights[current.index - 1] = (weights[current.index - 1] ?? 0) + delta;
                weights[current.index] = (weights[current.index] ?? 0) - delta;
                container.editorGroups.setWeights(weights);
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                drag.current = null;
              }}
            />
          ) : null}
          <div
            className="editor-area__group"
            style={{ flex: `${String(state.weights[index] ?? 1)} 1 0` }}
          >
            <EditorGroupView
              {...rest}
              group={group}
              active={group.id === state.activeGroupId}
              showWelcome={state.groups.length === 1}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
