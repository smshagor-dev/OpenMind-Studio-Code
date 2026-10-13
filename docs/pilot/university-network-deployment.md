# University test: network deployment on three physical computers

Everything below was verified on one development computer (real sockets, processes, databases, terminals and the real
release signature). This procedure is the part only real, separate computers can prove. Record each step as PASS or FAIL
with what you saw; `OpenMindStudio.exe --deploy test --json > pcN-test.json` saves the full test for each computer.

**You need**: three lab computers on one network (PC1, PC2, PC3 — the same Windows user name, e.g. `Student`, is fine
and is part of the test), the university test build (setup + portable ZIP for x64, with their `.sig` files), and for
the shared-installation part a network share every PC can read (`\\server\apps`) that PC1 may write.

## A. PC1 — the first computer (package source)

1. Install with the setup, choosing **For Me** and a non-default folder on a drive other than C: if the PC has one
   (e.g. `D:\Apps With Spaces\OpenMind Studio`). **PASS**: it starts; Help > About shows 1.0.3.
2. Help > Network Deployment. **PASS**: *This computer* shows PC1's name, the program in the chosen folder, layout
   "Installed for this user", data and database under that folder, runtimes "this computer's own".
3. Create `deploy\packages` next to `OpenMindStudio.exe` and copy the x64 setup, the x64 portable ZIP and both `.sig`
   files into it. In Settings > Network turn on **Offer This Installation on the Local Network**. Reopen the dialog.
   **PASS**: *Offered on the local network* says "package source … 2 package(s)", no "Left out" lines. Windows Firewall
   may ask once: allow private networks.
4. Run Test (with "Also download…"). **PASS**: deploymentDiscovery PASS (it finds itself), packageIntegrity PASS
   ("release signature … verified"). Note any FAIL/BLOCKED line verbatim.
5. Install Python from the Runtime Manager and run a `print(input())` program in a terminal. **PASS**: works.

## B. PC2 — same user name, discovery and provisioning

1. Copy only the portable ZIP to PC2, unzip anywhere, start it (or use any OpenMind Studio already there).
2. Help > Network Deployment > **Search the Network**. **PASS**: "Found."; PC1's deployment with both packages, "Answered
   from: <PC1's address>". If "No deployment found": type PC1's address into *Also ask these computers* and search
   again — if that works, broadcasts are blocked on this network (note it); if not, UDP 47741 is blocked (note it).
3. **Install with Setup…**, choose a folder on any drive (e.g. `C:\Student Apps` or `E:\`). **PASS**: "Installed
   OpenMind Studio 1.0.3", a Desktop shortcut "OpenMind Studio" starting the new folder's program, data under that
   folder; Start It opens it.
4. Run the same step again into the same folder. **PASS**: "Repaired …" (no second installation, data kept).
5. In the new copy, Help > Network Deployment > Run Test. **PASS**: databaseIsolation shows PC2's own database path
   (not PC1's); machineIdentity shows a profile id different from PC1's.
6. Open a terminal on PC1 and on PC2 at the same time; type `echo %COMPUTERNAME%` in each. **PASS**: each shows only its
   own name; closing PC1's terminal leaves PC2's running.

## C. Shared installation (PC1 installs it; PC2 and PC3 use it)

1. On PC1 run the setup, choose **Recommended for All Users** and the share (`\\server\apps\OpenMind Studio`). Start it
   from the share once. Turn on *Offer This Installation on the Local Network* there.
2. On PC1 install Python from the Runtime Manager of the **shared** installation. **PASS**: it lands in
   `\\server\apps\OpenMind Studio\runtimes\python`.
3. On PC3 (any OpenMind Studio copy, or the portable ZIP) Search the Network. **PASS**: a "shared network installation"
   with the share path and "Ready runtimes: python …".
4. **Use Shared Installation**. **PASS**: Desktop shortcut to `\\server\apps\OpenMind Studio\OpenMindStudio.exe`;
   starting it opens the workbench; Help > Network Deployment shows data under PC3's
   `%LOCALAPPDATA%\OpenMind\Studio\Installations\…`, runtimes "shared".
5. On PC3, Runtime Manager: Python shows **Installed** without downloading (no progress bar). A terminal runs `python
   --version`. **PASS**: works with no download.
6. Simultaneous first install: on PC2 and PC3 (both on the share) press Install for a runtime nobody installed yet
   (e.g. Node.js) at the same moment. **PASS**: one shows download progress, the other "Waiting for another computer that
   is installing it", then both show it installed; `runtimes\node\versions` holds one version folder, no `.installing`.
7. Run a Python program on PC2 and PC3 at the same time (`import time; print(input()); time.sleep(30)`), type different
   input on each. **PASS**: each terminal shows only its own input and output; stopping PC2's run leaves PC3's running.
8. Close OpenMind Studio on PC2. **PASS**: PC3 keeps working (no reset, no error).
9. Search from PC2 again with PC1 offering and PC3 running the share: the share appears **once**, answered from several
   addresses (one deployment, many sources).

## D. Negative checks

1. Unplug PC1's network (or close its OpenMind Studio) and search on PC2. **PASS**: "No deployment found" (or only the
   share via PC3) — no error dialog, no crash.
2. On PC1, replace one byte of the setup in `deploy\packages` (keep the `.sig`). **PASS**: the offer lists it under
   "Left out" (signature refused); PC2 can no longer install it.
3. Try **Install with Setup…** on PC2 into a folder that holds other files. **PASS**: refused ("…aren't OpenMind
   Studio; choose an empty folder"), nothing written.
4. Collaboration regression: create a room on PC1 and join it from PC2 over the LAN. **PASS**: as before.

Return the three `pcN-test.json` files and the PASS/FAIL list.
