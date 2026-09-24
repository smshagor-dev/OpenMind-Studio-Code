import {
  parseScopes,
  parseVariables,
  type DebugFrame,
  type DebugScope,
  type DebugVariable,
} from "./debugModel";
import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";

/** A variable in the tree; `children` is `null` until it is expanded for the first time. */
export interface VariableNode {
  key: string;
  variable: DebugVariable;
  expanded: boolean;
  loading: boolean;
  children: VariableNode[] | null;
}

export interface ScopeNode {
  key: string;
  scope: DebugScope;
  expanded: boolean;
  loading: boolean;
  variables: VariableNode[] | null;
}

export interface VariablesState {
  scopes: readonly ScopeNode[];
}

/**
 * The variables of the selected stack frame: its scopes (Locals, Globals, ...), each loaded when
 * first opened, and every variable that has children expandable the same way. The first scope
 * (Locals) opens by itself when the program pauses. Variables are read from the adapter, never guessed.
 */
export class VariablesService {
  private state: VariablesState = { scopes: [] };
  private readonly listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  /** Guards against an answer for an older frame landing after a newer selection. */
  private generation = 0;

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  getState(): VariablesState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  initialize(): void {
    this.dispose();
    this.offs.push(
      this.events.on("debugFrameSelected", (frame) => {
        void this.showFrame(frame);
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  async showFrame(frame: DebugFrame | null): Promise<void> {
    const generation = (this.generation += 1);
    if (frame === null) {
      this.set([]);
      return;
    }
    let scopes: DebugScope[];
    try {
      scopes = parseScopes(await this.ipc.debugRequest("scopes", { frameId: frame.id }));
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't read the scopes: ${String(error)}` });
      return;
    }
    if (generation !== this.generation) return;
    this.set(
      scopes.map((scope, index) => ({
        key: `s${String(index)}`,
        scope,
        expanded: false,
        loading: false,
        variables: null,
      })),
    );
    const first = this.state.scopes.find((node) => !node.scope.expensive);
    if (first) await this.toggleScope(first.key);
  }

  async toggleScope(key: string): Promise<void> {
    const node = this.state.scopes.find((entry) => entry.key === key);
    if (!node) return;
    if (node.expanded) {
      this.patchScope(key, { expanded: false });
      return;
    }
    if (node.variables !== null) {
      this.patchScope(key, { expanded: true });
      return;
    }
    this.patchScope(key, { expanded: true, loading: true });
    const generation = this.generation;
    const variables = await this.read(node.scope.variablesReference);
    if (generation !== this.generation) return;
    this.patchScope(key, { loading: false, variables: this.nodes(key, variables) });
  }

  async toggleVariable(key: string): Promise<void> {
    const node = this.findVariable(key);
    if (!node || node.variable.variablesReference === 0) return;
    if (node.expanded) {
      this.patchVariable(key, { expanded: false });
      return;
    }
    if (node.children !== null) {
      this.patchVariable(key, { expanded: true });
      return;
    }
    this.patchVariable(key, { expanded: true, loading: true });
    const generation = this.generation;
    const children = await this.read(node.variable.variablesReference);
    if (generation !== this.generation) return;
    this.patchVariable(key, { loading: false, children: this.nodes(key, children) });
  }

  private async read(reference: number): Promise<DebugVariable[]> {
    try {
      return parseVariables(
        await this.ipc.debugRequest("variables", { variablesReference: reference }),
      );
    } catch (error) {
      this.events.emit("appError", { message: `Couldn't read the variables: ${String(error)}` });
      return [];
    }
  }

  private nodes(parentKey: string, variables: DebugVariable[]): VariableNode[] {
    return variables.map((variable, index) => ({
      key: `${parentKey}/${String(index)}`,
      variable,
      expanded: false,
      loading: false,
      children: null,
    }));
  }

  private findVariable(key: string): VariableNode | null {
    const visit = (nodes: VariableNode[] | null): VariableNode | null => {
      for (const node of nodes ?? []) {
        if (node.key === key) return node;
        const inner = visit(node.children);
        if (inner) return inner;
      }
      return null;
    };
    for (const scope of this.state.scopes) {
      const found = visit(scope.variables);
      if (found) return found;
    }
    return null;
  }

  private patchScope(key: string, patch: Partial<ScopeNode>): void {
    this.set(this.state.scopes.map((node) => (node.key === key ? { ...node, ...patch } : node)));
  }

  private patchVariable(key: string, patch: Partial<VariableNode>): void {
    const map = (nodes: VariableNode[] | null): VariableNode[] | null =>
      nodes === null
        ? null
        : nodes.map((node) =>
            node.key === key ? { ...node, ...patch } : { ...node, children: map(node.children) },
          );
    this.set(this.state.scopes.map((scope) => ({ ...scope, variables: map(scope.variables) })));
  }

  private set(scopes: ScopeNode[]): void {
    this.state = { scopes };
    for (const listener of this.listeners) listener();
  }
}
