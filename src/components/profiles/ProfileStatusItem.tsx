import { useSyncExternalStore } from "react";

import { container } from "../../services/container";

/** The active profile in the status bar; click opens the Profiles window. Shown once the profiles were read. */
export function ProfileStatusItem() {
  const { list } = useSyncExternalStore(container.profiles.subscribe, container.profiles.getState);
  const active = list?.profiles.find((profile) => profile.active);
  if (active === undefined) return null;
  return (
    <button
      type="button"
      className="statusbar__item"
      title="Profile - switch, create or manage profiles"
      onClick={() => {
        void container.profiles.openWindow();
      }}
    >
      {active.name}
    </button>
  );
}
