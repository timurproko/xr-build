# dev-control-panel Specification

## Purpose
A local control panel in the browser where a developer manages the projects of their workspace: per-project settings
and providers, web and package builds, built packages, runs on the display, and live status, logs and debug views.

## Requirements
### Requirement: Start without a terminal
The panel SHALL start from a single launcher that shows no console window. The launcher opens the panel in the default browser. When a panel is already running, the launcher opens that panel instead of starting a second server.

#### Scenario: First start
- **WHEN** the developer runs the panel launcher and no panel is running
- **THEN** the panel server starts with no visible console window and the browser opens the panel page

#### Scenario: Already running
- **WHEN** the developer runs the launcher while a panel is running
- **THEN** the browser opens the running panel and no second server starts

### Requirement: Local-only access
The panel SHALL accept connections only on the loopback interface. It SHALL reject any request whose Host header is not a loopback name and port of the panel. It SHALL reject any state-changing request whose Origin is not the panel itself.

#### Scenario: Request from another site
- **WHEN** a page from another origin sends a request to the panel's build endpoint
- **THEN** the panel rejects it and starts nothing

#### Scenario: Access from the network
- **WHEN** another machine tries to connect to the panel's port on the developer machine's network address
- **THEN** the connection is not accepted

### Requirement: Project convention
A project SHALL be a folder with an `xrb-project.json` manifest in `projects/<section>/` of the workspace (`projects/Unsorted/` for no section). The manifest names the display name, the kind (`app`, packageable, or `test`, run only), the entry (build output or static folder), an optional build script, the providers (`input`, `display`, for apps `platform`) and per-plugin settings under `plugins.<name>`, including an app's package identity.

#### Scenario: Test project
- **WHEN** a project is a rig, camera, hand or calibration check
- **THEN** it has kind `test`: it can be run but not packaged

#### Scenario: New project
- **WHEN** a developer adds `projects/Checks/camera-check/` to the workspace with an `xrb-project.json` of kind `test` and an `index.html`, and refreshes the panel
- **THEN** "camera-check" appears in the project list and can be run, with no other registration step

#### Scenario: Folder without a manifest
- **WHEN** a folder in a section folder of the workspace's `projects/` has a `package.json` but no `xrb-project.json`
- **THEN** it is not a project and is not listed, and the panel offers to create a manifest for it with defaults from its `package.json`

#### Scenario: Invalid manifest
- **WHEN** a manifest is not valid JSON or lacks a name or kind
- **THEN** the project is listed as broken, with the file path and the error, and cannot be run or built

### Requirement: Unique project names
Project folder names SHALL be unique across all sections and the archive; a project keeps its name (and its colour) when it moves between sections.

#### Scenario: Same name in two sections
- **WHEN** `projects/Demos/globe` and `projects/Checks/globe` both hold a manifest
- **THEN** the first one is listed normally and the second is listed as broken, naming the section that already has a project of that name

### Requirement: Project list
The left column SHALL list the projects in sections the developer manages. Sections SHALL be the section folders of the workspace's `projects/`; `xrb-panel.json` in the workspace keeps only their order, the order of projects, colours and where archived projects came from. Each row SHALL show the project's icon, name, last web build time and version, and a status dot while it launches (blue) or runs (green). The list scrolls on its own, independent of the page.

#### Scenario: Own sections
- **WHEN** the developer creates a section "Demos" and drags hello-cube into it
- **THEN** hello-cube's folder moves to `projects/Demos/hello-cube`, and the list shows it there after a reload

#### Scenario: Manage sections
- **WHEN** the developer renames a section (double-click), reorders sections, drags a project within or between sections, or deletes a section
- **THEN** the folders follow (a renamed section's projects move to the new folder), and the projects of a deleted section move to `projects/Unsorted/`

#### Scenario: Project in no section
- **WHEN** a project is in `projects/Unsorted/`
- **THEN** it is shown in an "Unsorted" section at the end of the list

#### Scenario: Right-click menu
- **WHEN** the developer right-clicks a project row
- **THEN** a menu offers Rename, a colour (none by default), Archive and Delete

#### Scenario: Colour
- **WHEN** the developer picks green for rig-check from its right-click menu
- **THEN** the rig-check row shows a green bar, and the other rows show none

### Requirement: Archive and delete
The panel SHALL let the developer archive a project: its folder moves to the workspace's `projects/archive/<name>` and it leaves the project list; unarchiving moves it back to the section it came from (Unsorted when that section is gone). The list has two tabs, Projects and Archive, each with a count. An archived project can be selected, run and built from the Archive tab, and unarchived from its right-click menu.

#### Scenario: Archive
- **WHEN** the developer archives eyes-check
- **THEN** the workspace's `projects/Checks/eyes-check` moves to `projects/archive/eyes-check`, it shows under the Archive tab, and it still runs from there

#### Scenario: Unarchive
- **WHEN** the developer chooses Unarchive on eyes-check in the Archive tab
- **THEN** it moves back to `projects/Checks/eyes-check` and shows under the Projects tab, in its section

### Requirement: Delete
Delete SHALL move the project folder to the Recycle Bin after a confirmation in the panel's own dialog.

#### Scenario: Delete
- **WHEN** the developer deletes a project and confirms
- **THEN** its folder is in the Recycle Bin and the project is gone from the list

### Requirement: Project view
The middle column SHALL show the selected project in one card, with a Settings card and the Log card below it. The card SHALL hold the icon on black (a click opens the icon studio), the name, the project folder as a link that opens it in Explorer, and the actions one per row, buttons as wide as the icon: Run (with its options), Build (last build time), and for apps Build package with the version field (last packaged version).

#### Scenario: Tags
- **WHEN** the project uses the default icon, its icon changed since the last package build, or it is archived
- **THEN** the card shows a tag saying so

#### Scenario: Run turns into Stop
- **WHEN** the developer clicks Run
- **THEN** the Run button turns into Stop in place while the project runs

#### Scenario: Stop from anywhere
- **WHEN** an app runs and the developer has scrolled the log so that the Stop button is out of view
- **THEN** the top bar shows the project's icon, name and Stop, and clicking it stops the app

### Requirement: Project icon
Every project SHALL have one icon: a PNG named in its manifest, or the default icon when none is named. For an app it is the window and taskbar icon of the running app, transparency kept, and the source of the package thumbnail, whose format the platform's packager decides. The panel SHALL show each project's icon on black in the list and in the project view, and pass it to the host when running the project.

#### Scenario: Custom icon
- **WHEN** the developer sets `icon.png` as the icon of globe and builds a package
- **THEN** the panel shows that image for the project, the package's thumbnail is made from it, and the running app's window shows it, transparent, in the taskbar

#### Scenario: No icon set
- **WHEN** a project's manifest names no icon
- **THEN** the panel shows the default icon for it with a "default icon" tag, and the package and the running app use the default icon

#### Scenario: Not a PNG
- **WHEN** the developer chooses an icon file that is not a PNG
- **THEN** the panel refuses to save it and says the icon must be a PNG

### Requirement: Icon studio
Clicking a project's icon SHALL open the icon studio: a modal that runs the app's icon view live at 512 x 512 on a checkered background showing transparency, with the current thumbnail (the icon on black) beside it and a help line naming the controls (drag to turn, scroll to zoom, Take). Take SHALL save the current frame as the project's icon PNG and update the thumbnail. Every page built on the SDK's `createXrb()` answers the studio.

#### Scenario: Open the studio
- **WHEN** the developer clicks a project's icon
- **THEN** the studio shows a spinner while the icon view loads, then the live preview and the thumbnail side by side, and an × in the corner closes it

#### Scenario: Take a view
- **WHEN** the developer opens the icon studio for globe, turns the globe to show one continent, and clicks Take
- **THEN** the project's `icon.png` holds that view at 512 x 512 with a transparent background, the panel shows it as the project icon, and the project shows the "icon changed" tag until the next package build

#### Scenario: Pause an animation
- **WHEN** the app supports pausing, and the developer pauses hello-cube's spinning cubes with the Pause button on the preview, drags in the preview, and resumes
- **THEN** the cubes stop while paused, the preview takes no mouse input so the drag has no effect, they continue from where they stopped, and Take during the pause captures the paused frame

#### Scenario: Used by the next build
- **WHEN** the developer builds a package after taking a new icon
- **THEN** the package's thumbnail and window icon are the new image

#### Scenario: Cancel
- **WHEN** the developer closes the icon studio without clicking Take
- **THEN** the project's icon file is unchanged

#### Scenario: Page without the SDK
- **WHEN** the developer opens the studio for rig-check, a plain canvas page that does not answer within 10 seconds, or for a project that is not built yet
- **THEN** the studio says the page has no live icon view and offers Choose PNG…, which sets the chosen PNG as the icon

### Requirement: Project settings
The Settings card SHALL hold the project's Title (the manifest name, and for apps also the platform title), its Display, Input and, for apps, Platform (choices listed by `xrb-host --list-plugins`), and the identity fields the platform's packager declares except the version, which is set next to Build package. Changes SHALL be saved to the manifest without a Save button. The panel SHALL re-read the manifest before writing and refuse when it changed on disk since loading.

#### Scenario: Change the title
- **WHEN** the developer changes globe's title to "Globe Tour" and presses Enter
- **THEN** the manifest's name and the platform's title field are "Globe Tour", the package ID is unchanged, and the next package build carries the new title

#### Scenario: Saving without a button
- **WHEN** the developer changes a dropdown, or edits the title and presses Enter or leaves the field
- **THEN** the manifest is saved and a "saved" note confirms it; an "Open JSON" link opens the manifest in the code editor for everything else (entry, scripts, icon path, plugin settings)

#### Scenario: Fixed identity field
- **WHEN** the platform's packager declares the package ID as fixed and the app has been packaged once
- **THEN** the package ID is shown read-only, because the platform tells packages apart by it and a change would make a new, separate app there

#### Scenario: Provider not built
- **WHEN** the manifest selects a provider that is not built in the workspace
- **THEN** the selector keeps the value and marks it missing

#### Scenario: Manifest changed on disk
- **WHEN** the manifest was edited on disk after the panel loaded it, and the developer changes a setting
- **THEN** the panel does not write and says the manifest changed

#### Scenario: Empty title
- **WHEN** the developer clears the title
- **THEN** the panel does not save and says the title is required

### Requirement: Web build
The panel SHALL run a project's configured build script in the project folder. It SHALL stream the output live (without terminal colour codes) and report success or failure with the exit code.

#### Scenario: Successful build
- **WHEN** the developer clicks Build on hello-cube
- **THEN** the build output appears live in the Jobs list, the result shows success, and the build time is updated

#### Scenario: Failing build
- **WHEN** the build script exits with a non-zero code
- **THEN** the panel shows the failure, the exit code and the last output lines, and leaves the previous build time unchanged

### Requirement: Package build
The panel SHALL build a package for an app project from its entry folder and settings through the packager of the project's platform, writing it to the workspace's `builds/`. It SHALL use the same packaging engine as the packager's command line, so the package matches a command-line build for the same inputs. Progress and errors are streamed live, and the result names the package file, its version and its size.

#### Scenario: Package a project
- **WHEN** the developer clicks Build package on a project with package ID "Globe Tour" and version 0.1.1
- **THEN** a package for "Globe Tour" version 0.1.1 is written to the workspace's `builds/`, and the panel shows its path and size

#### Scenario: No web build
- **WHEN** the developer builds a package for a project whose entry folder has no `index.html`
- **THEN** the package build is refused with a message to run the web build first

#### Scenario: No packager
- **WHEN** an app has no platform, or no packager is present for its platform
- **THEN** the panel shows packaging as unavailable and still builds and runs the project

#### Scenario: Selected plugin not built
- **WHEN** a selected provider is a plugin that is not built in the workspace
- **THEN** the package build is refused with a message naming the plugin and asking for a host rebuild

#### Scenario: One package build at a time
- **WHEN** a package build is running and the developer starts another
- **THEN** the second is refused until the first finishes

### Requirement: Next version suggestion
After a successful package build the panel SHALL record the packaged version for the project. It SHALL then suggest the next patch version for the following build. Before a build, it SHALL warn when the chosen version is not higher than the last packaged version for that package ID.

#### Scenario: Suggest after build
- **WHEN** a project was last packaged as 0.1.0
- **THEN** the version field suggests 0.1.1, and "last 0.1.0" shows on the right of the row

#### Scenario: Same version again
- **WHEN** the developer starts a package build with version 0.1.0 and 0.1.0 was already packaged for that ID
- **THEN** the panel warns that the station platform may reject an existing version and asks for confirmation before building

### Requirement: Activity column
The right column SHALL show cards in one list-item style: Running, the live status of the host; Jobs, web builds, package builds and host rebuilds with state, duration and collapsible output, and a Clear link that removes finished jobs without asking; Built packages, the packages in the workspace's `builds/` with the package ID, title, version, size and build time read from each, and an "Open Folder" link that opens `builds/` in Explorer, in front of the browser, for upload.

#### Scenario: Package built by a script
- **WHEN** a package in the workspace's `builds/` was built with the packager's command line, not with the panel
- **THEN** the panel lists it with the ID, version and build time read from the package

### Requirement: Run on the display
The panel SHALL start `xrb-host` for a project in one of two modes, chosen with the Dev server checkbox (remembered per project): built, from the project's entry folder; or dev server, for projects with a dev script, the project's dev server with live reload, which the panel starts and stops with the host. Only one host runs at a time. The host runs with the project's provider selections and plugin settings, and loads the workspace's plugins. Test projects run like apps.

#### Scenario: Run the built app
- **WHEN** the developer clicks Run on globe with Dev server off
- **THEN** the host shows the app's build output on the 3D display, and the panel shows the project as launching, then running

#### Scenario: Run with the dev server
- **WHEN** the developer clicks Run with Dev server on, and then saves a source file of the app
- **THEN** the app on the display reloads with the change, without restarting the host

#### Scenario: Another host already running
- **WHEN** the developer clicks Run while a host started elsewhere is running
- **THEN** the panel says that another host is running and offers to stop it, and does not start a second host

### Requirement: 2D mode
The 2D mode checkbox next to Run SHALL start the app without the 3D effect (remembered per project). While an app runs on a display that can switch, the checkbox SHALL switch the running app between 2D and 3D and show the view the host reports; on a display that cannot switch it is disabled while the app runs.

#### Scenario: Switch while running
- **WHEN** the developer ticks 2D mode while an app runs in 3D on the display
- **THEN** the app continues as a flat picture without restarting, and unticking it brings the 3D effect back

#### Scenario: Display that cannot switch
- **WHEN** a project runs on a display provider that reports it cannot switch views at run time (for example a display plugin set to a fixed 2D mode)
- **THEN** the 2D mode checkbox is disabled until the app stops

### Requirement: Clean stop
The panel SHALL stop a running host through the host's normal close path, so the display provider ends its 3D output and session and the input provider releases its devices. Only if the host has not exited 20 seconds after the close request SHALL the panel force it to end, and it then warns that the display may need a replug.

#### Scenario: Stop
- **WHEN** the developer clicks Stop on a running project
- **THEN** the host log shows the clean shutdown, the host exits with code 0, and the 3D display returns to 2D

#### Scenario: Host closed on the display
- **WHEN** the host is closed with Esc on the display
- **THEN** the panel shows the project as stopped, with the exit code

### Requirement: Live run status
The Running card SHALL show at all times (dashes while nothing runs), refreshed at least once per second while a host started by the panel runs: page frames per second and frame time; hand tracking rate and state; camera-to-page hand latency, number of tracked hands, render resolution per eye, connected page clients and running time. None of these values are drawn inside the running app.

#### Scenario: Running app
- **WHEN** globe runs on the 3D display with hand input
- **THEN** the panel shows a page fps near 60 and a hand rate updating every second, and the app on the display shows no stats overlay

#### Scenario: Run a test project
- **WHEN** the developer runs the rig-check test project with hand recording on
- **THEN** the rig check page shows on the 3D display, and the recorded hand stream is saved to the file named in its settings

#### Scenario: Host crash
- **WHEN** the host exits unexpectedly with a non-zero code
- **THEN** the panel shows the project as stopped, with the exit code and the last host log lines

### Requirement: Host log
The Log card SHALL show the host log live like a game-engine console: one row per message with time, a source badge and the text, zebra rows, multi-line messages kept together, and repeats of a message collapsed into one row with a ×N count. Warnings are amber and errors red. The header SHALL hold filters for Messages, Warnings and Errors, each with its count, a Debug filter and a Clear link.

#### Scenario: Only errors
- **WHEN** the developer turns Messages and Warnings off
- **THEN** only error rows are shown, the two filters are dimmed and struck through, the counts of all three kinds stay visible, and the choice is remembered

#### Scenario: Plugin debug output
- **WHEN** the developer turns on the Debug filter (off by default) while an app runs with a plugin input provider
- **THEN** the plugins' own debug output (for example the input provider's gesture events and profiling) is shown in the log

#### Scenario: Empty log
- **WHEN** the log is empty, or fills up
- **THEN** the Clear link stays in place (disabled while the log is empty) and the log keeps one height, so the page does not move

### Requirement: Panel dialogs and controls
Confirmations, questions and messages SHALL use the panel's own dialogs, not the browser's alert, confirm or prompt. Buttons follow one style: secondary (raised, bordered), primary (filled accent) and danger (filled red), with the same hover (fill tinted, border highlighted) and pressed states for all. Dropdowns use the panel's own list. Light and dark follow the system theme.

#### Scenario: Delete confirmation
- **WHEN** the developer chooses Delete on a project
- **THEN** a panel dialog asks for confirmation with a red Delete button

### Requirement: Camera debug view
When the developer runs a project with the Cameras option and its input provider publishes debug images, the panel SHALL show each image stream the provider labels (for example per-camera infrared, depth or colour images at a reduced rate and size, with the 2D hand detections drawn on them when the tracker provides them) and each camera's frame rate. The host SHALL send debug images only for a run started with that option.

#### Scenario: Open the debug view
- **WHEN** the developer runs globe with Cameras on and a camera-based input provider
- **THEN** within 2 seconds the panel shows the labelled images of every connected camera, updating at least 5 times per second, with the detected hands marked

#### Scenario: Run without the debug view
- **WHEN** the developer runs a project with Cameras off
- **THEN** the host sends no camera images, and the page fps on the display is not lower because of the debug view

#### Scenario: No cameras
- **WHEN** a host runs with input `none`, or no camera is connected
- **THEN** the debug view says why no images are shown, instead of showing an empty area

### Requirement: Hand data debug view
The debug view SHALL show the tracked 3D hands in the panel frame as top and side views of the joints, with each hand's ID, pinch state and age. It updates at the tracking rate.

#### Scenario: Hand moves toward the panel
- **WHEN** a tracked hand moves toward the display glass
- **THEN** the side view shows the joints approaching the panel plane, and the hand keeps the same ID

### Requirement: Host freshness check
The panel SHALL check whether the `xrb-host` build and the build of every workspace plugin exist and whether one is older than its newest source file (for the host, by the build's own record of its last successful build). Plugins left next to the host by an older build SHALL also make the host outdated. The top bar shows a chip and a Rebuild host button only when something is missing or outdated. The panel SHALL warn before a package build with an outdated host.

#### Scenario: Outdated host
- **WHEN** a host or workspace plugin source file was changed after `xrb-host.exe` or that plugin was built
- **THEN** the top bar shows the host as outdated, and a package build asks for confirmation first

#### Scenario: Plugins left next to the host
- **WHEN** the host's build folder still holds plugins installed there by an older build
- **THEN** the top bar shows the host as outdated, and Rebuild host removes those plugin folders

#### Scenario: Rebuild host
- **WHEN** the developer clicks Rebuild host while no host is running
- **THEN** the host and then every workspace plugin are rebuilt with the output streamed live as a job, and the chip disappears on success
