; Inno Setup script - Windows installer for RRS Part List Studio
; Build after PyInstaller:  iscc /DAppVersion=0.1.0 packaging\windows_installer.iss
; Output: dist\installer\RRS-PartListStudio-Setup-<version>.exe

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppName "RRS Part List Studio"
#define AppExe "RRS Part List Studio.exe"

[Setup]
AppId={{6C1E2A53-7B0B-4E8E-9C4D-2F5B9A6E1A01}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=RRS
DefaultDirName={autopf}\RRS Part List Studio
DefaultGroupName=RRS Part List Studio
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=RRS-PartListStudio-Setup-{#AppVersion}
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Installing for the current user only needs no administrator rights.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\RRS Part List Studio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Double-click a .rrspl job file to open it in the program.
Root: HKA; Subkey: "Software\Classes\.rrspl"; ValueType: string; ValueName: ""; ValueData: "RRS.PartList"; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\RRS.PartList"; ValueType: string; ValueName: ""; ValueData: "RRS Part List"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\RRS.PartList\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"
Root: HKA; Subkey: "Software\Classes\RRS.PartList\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
