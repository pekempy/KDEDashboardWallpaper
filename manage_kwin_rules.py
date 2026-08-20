import os
import subprocess
import sys
import configparser

def run_command(cmd):
    try:
        result = subprocess.run(cmd, shell=True, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error executing command '{cmd}': {e.stderr}", file=sys.stderr)
        return None

def main():
    config_path = os.path.expanduser("~/.config/kwinrulesrc")
    print(f"Reading KWin rules from {config_path}...")
    
    config = configparser.ConfigParser(strict=False, interpolation=None)
    config.optionxform = str
    
    if os.path.exists(config_path):
        try:
            config.read(config_path)
        except Exception as e:
            print(f"Warning: Could not parse config file with configparser: {e}. Attempting manual fallback.")
    
    # 1. Check if a rule for 'dashboard-wallpaper' already exists
    rule_id = None
    for section in config.sections():
        if section == "General" or section.startswith("$"):
            continue
        if config.has_option(section, "wmclass") and config.get(section, "wmclass") == "dashboard-wallpaper":
            rule_id = section
            print(f"Found existing rule for 'dashboard-wallpaper' at section [{rule_id}]")
            break
            
    # 2. If it does not exist, find a new rule ID and register it
    if rule_id is None:
        # Determine existing rule numbers
        existing_ids = []
        for section in config.sections():
            if section.isdigit():
                existing_ids.append(int(section))
        
        rule_id = str(max(existing_ids) + 1 if existing_ids else 1)
        print(f"Creating a new rule at section [{rule_id}]")
        
        # Read General section
        count = 0
        rules_list = []
        if config.has_section("General"):
            if config.has_option("General", "count"):
                count = int(config.get("General", "count"))
            if config.has_option("General", "rules"):
                rules_str = config.get("General", "rules")
                if rules_str.strip():
                    rules_list = [r.strip() for r in rules_str.split(",") if r.strip()]
        
        count += 1
        rules_list.append(rule_id)
        
        # Update General section using kwriteconfig5
        run_command(f'kwriteconfig5 --file ~/.config/kwinrulesrc --group General --key count "{count}"')
        run_command(f'kwriteconfig5 --file ~/.config/kwinrulesrc --group General --key rules "{",".join(rules_list)}"')
    
    # 3. Set the properties for the rule
    properties = {
        "description": "Dashboard Wallpaper Panel",
        "wmclass": "dashboard-wallpaper",
        "wmclassmatch": "1",          # 1 = Exact Match
        "wmclasscomplete": "false",
        
        # Window Type (Normal window, but we force it below everything and style it)
        "types": "1",                 # 1 = Normal Window type
        "typesrule": "2",             # 2 = Force
        
        # Borderless
        "noborder": "true",
        "noborderrule": "2",          # 2 = Force
        
        # Keep Below
        "below": "true",
        "belowrule": "2",             # 2 = Force
        
        # Prevent minimizing and closing
        "minimizable": "false",
        "minimizerule": "2",          # 2 = Force
        "closeable": "false",
        "closeablerule": "2",         # 2 = Force
        
        # Skip taskbar, pager, and switcher (Alt+Tab)
        "skiptaskbar": "true",
        "skiptaskbarrule": "2",       # 2 = Force
        "skippager": "true",
        "skippagerrule": "2",         # 2 = Force
        "skipswitcher": "true",
        "skipswitcherrule": "2",      # 2 = Force
        
        # Virtual Desktops (0 = All Desktops)
        "desktop": "0",
        "desktoprule": "2",           # 2 = Force
        
        # Maximization
        "maxhoriz": "true",
        "maxhorizrule": "2",          # 2 = Force
        "maxvert": "true",
        "maxvertrule": "2",           # 2 = Force
        
        # Size (1920x1080)
        "size": "1920,1080",
        "sizerule": "2",              # 2 = Force
        
        # Position (0,0)
        "position": "0,0",
        "positionrule": "2",          # 2 = Force
    }
    
    for key, value in properties.items():
        run_command(f'kwriteconfig5 --file ~/.config/kwinrulesrc --group "{rule_id}" --key "{key}" "{value}"')
        
    print("Rule properties configured successfully.")
    
    # 4. Trigger KWin reload
    print("Triggering KWin reconfiguration...")
    run_command("qdbus org.kde.KWin /KWin reconfigure")
    print("KWin rules reconfigured and reloaded successfully.")

if __name__ == "__main__":
    main()
