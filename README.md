# Vaal Trade Assistant

A Chrome extension that adds quick trade search buttons to items on poe.ninja for Path of Exile 2.

## Features

- **Quick Trade Search**: Adds yellow (similar) and green (exact) buttons on items in poe.ninja
- **Automatic Stats Matching**: Finds matching stat IDs from the PoE2 trade API
- **Min Value Thresholds**: Similar searches use 80% of item values as minimum
- **POESESSID Integration**: Automatically fetches your session from cookies

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder
5. Click the extension icon and configure your POESESSID

## Usage

1. Navigate to poe.ninja's PoE2 builds section
2. Hover over any item to see trade buttons
3. Click the **yellow button** for a "similar" search (80% min values)
4. Click the **green button** for an "exact" search (exact values)

## Configuration

- **Trade Type**: Choose between Instant Buyout, In Person, or Any
- **POESESSID**: Required for trade searches. Click "Get" to auto-fetch from PoE cookies

## Requirements

- Google Chrome (or Chromium-based browser)
- Path of Exile account (logged in to pathofexile.com)

## License

MIT License
