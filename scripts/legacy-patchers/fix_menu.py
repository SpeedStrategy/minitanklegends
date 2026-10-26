import re

# Read the corrupted file
with open(r'C:\Users\LENOVO\Desktop\Mini Tank Legends Cline\js\menu.js', 'r', encoding='utf-8') as f:
    content = f.read()

# The corruption starts after "_detectPlatform(){" function definition opens
# and contains merge conflict markers. We need to find the start and end
# Start marker: the beginning of _detectPlatform function
start_marker = '  _detectPlatform(){'
start_idx = content.find(start_marker)

# End marker: the correct _showSection function that has proper body
# We look for the LAST occurrence of the corrupted zone before a clean _showSection
end_marker = '\n  _showSection(id){\n    document.querySelectorAll'

# Find all occurrences of _showSection to find the first clean one after corruption
# The corruption ends when we see the real _showSection with its full body

# Find the corrupted zone - everything from start_marker to the last occurrence of 
# merge conflict markers before clean _showSection
clean_showSection_idx = content.find(end_marker, start_idx)

if start_idx >= 0 and clean_showSection_idx >= 0:
    # Build the correct replacement code
    replacement = '''  _detectPlatform(){
    const ua = navigator.userAgent;
    // iPadOS 13+ reports as Mac but has touch support
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(ua) && 'ontouchstart' in window && navigator.maxTouchPoints > 0);
    const isAndroid = /Android/i.test(ua);
    if(isIOS) return 'ios';
    if(isAndroid) return 'android';
    return 'desktop';
  },

  _isFullscreen(){
    // Check Fullscreen API (programmatic fullscreen via button)
    if(document.fullscreenElement || document.webkitFullscreenElement) return true;
    
    // Detect F11 browser fullscreen by checking if window dimensions match screen dimensions
    // Use a small tolerance (50px) to account for taskbar/bookmark bars
    const tolerance = 50;
    const wMatch = Math.abs(window.outerWidth - screen.width) <= tolerance;
    const hMatch = Math.abs(window.outerHeight - screen.height) <= tolerance;
    return wMatch && hMatch;
  },

  _requestFullscreen(){
    const el = document.documentElement;
    if(el.requestFullscreen){
      el.requestFullscreen().catch(() => {});
    } else if(el.webkitRequestFullscreen){
      el.webkitRequestFullscreen();
    }
  },

  /* --- Show only one section inside the overlay --- */
  _showSection(id){
    document.querySelectorAll('.fs-section').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById(id);
    if(el) el.classList.remove('hidden');
  },'''
    
    new_content = content[:start_idx] + replacement + content[clean_showSection_idx:]
    
    with open(r'C:\Users\LENOVO\Desktop\Mini Tank Legends Cline\js\menu.js', 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Verify by counting remaining merge conflict markers
SEARCH
import re

# Read the corrupted file
with open(r'C:\Users\LENOVO\Desktop\Mini Tank Legends Cline\js\menu.js', 'r', encoding='utf-8') as f:
    content = f.read()

# The corruption starts after "_detectPlatform(){" function definition opens
# and contains merge conflict markers. We need to find the start and end
# Start marker: the beginning of _detectPlatform function
start_marker = '  _detectPlatform(){'
start_idx = content.find(start_marker)

# End marker: the correct _showSection function that has proper body
# We look for the LAST occurrence of the corrupted zone before a clean _showSection
end_marker = '\n  _showSection(id){\n    document.querySelectorAll'

# Find all occurrences of _showSection to find the first clean one after corruption
# The corruption ends when we see the real _showSection with its full body

# Find the corrupted zone - everything from start_marker to the last occurrence of 
# merge conflict markers before clean _showSection
clean_showSection_idx = content.find(end_marker, start_idx)

if start_idx >= 0 and clean_showSection_idx >= 0:
    # Build the correct replacement code
    replacement = '''  _detectPlatform(){
    const ua = navigator.userAgent;
    // iPadOS 13+ reports as Mac but has touch support
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(ua) && 'ontouchstart' in window && navigator.maxTouchPoints > 0);
    const isAndroid = /Android/i.test(ua);
    if(isIOS) return 'ios';
    if(isAndroid) return 'android';
    return 'desktop';
  },

  _isFullscreen(){
    // Check Fullscreen API (programmatic fullscreen via button)
    if(document.fullscreenElement || document.webkitFullscreenElement) return true;
    
    // Detect F11 browser fullscreen by checking if window dimensions match screen dimensions
    // Use a small tolerance (50px) to account for taskbar/bookmark bars
    const tolerance = 50;
    const wMatch = Math.abs(window.outerWidth - screen.width) <= tolerance;
    const hMatch = Math.abs(window.outerHeight - screen.height) <= tolerance;
    return wMatch && hMatch;
  },

  _requestFullscreen(){
    const el = document.documentElement;
    if(el.requestFullscreen){
      el.requestFullscreen().catch(() => {});
    } else if(el.webkitRequestFullscreen){
      el.webkitRequestFullscreen();
    }
  },

  /* --- Show only one section inside the overlay --- */
  _showSection(id){
    document.querySelectorAll('.fs-section').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById(id);
    if(el) el.classList.remove('hidden');
  },'''
    
    new_content = content[:start_idx] + replacement + content[clean_showSection_idx:]
    
    with open(r'C:\Users\LENOVO\Desktop\Mini Tank Legends Cline\js\menu.js', 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Verify by counting remaining merge conflict markers
    print(f"File fixed! Remaining conflict markers: {markers}")
    
    # Also verify _detectPlatform has proper return
    if 'return \'desktop\';' in new_content[new_content.find('_detectPlatform'):new_content.find('_detectPlatform')+300]:
        print("_detectPlatform has proper returns")
    else:
        print("WARNING: _detectPlatform may still be broken")
else:
    print(f"start_idx={start_idx}, clean_showSection_idx={clean_showSection_idx}")
    print(f"First 5000 chars:\n{content[4200:4700]}")
