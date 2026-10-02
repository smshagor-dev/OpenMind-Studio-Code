import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MySqlStatus } from "../services/ipc";
import { STOPPED_MYSQL } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { RuntimeDatabaseLine } from "./RuntimeDatabaseLine";

function withStatus(status: MySqlStatus) {
  const state = { status, busy: null };
  const mySql = {
    subscribe: () => () => undefined,
    getState: () => state,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  harness.current = { mySql };
  return mySql;
}

afterEach(() => {
  cleanup();
  harness.current = null;
});

describe("MariaDB card: database line", () => {
  it("says Ready once the database exists, and re-reads the status when shown", () => {
    const mySql = withStatus(STOPPED_MYSQL);
    render(<RuntimeDatabaseLine installed />);
    expect(screen.getByText("Database:")).toBeInTheDocument();
    expect(screen.getByText("Ready (root / root, 127.0.0.1 only)")).toBeInTheDocument();
    expect(mySql.refresh).toHaveBeenCalled();
  });

  it("keeps a failed automatic set-up visible with its reason", () => {
    withStatus({
      ...STOPPED_MYSQL,
      state: "error",
      initialized: false,
      error: "E:\\x\\data\\mariadb holds files but no complete MariaDB database, so OpenMind won't initialize over it.",
    });
    render(<RuntimeDatabaseLine installed />);
    expect(screen.getByText("Database: Not set up")).toBeInTheDocument();
    expect(screen.getByText(/won't initialize over it/)).toBeInTheDocument();
  });

  it("says when it will be created, and shows nothing before MariaDB is installed", () => {
    withStatus({ ...STOPPED_MYSQL, initialized: false });
    const { rerender, container } = render(<RuntimeDatabaseLine installed />);
    expect(screen.getByText("It is created when MySQL starts.")).toBeInTheDocument();
    rerender(<RuntimeDatabaseLine installed={false} />);
    expect(container.innerHTML).toBe("");
  });
});
