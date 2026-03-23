# Au99.99 Badge (Chrome Extension)

Shows Shanghai Gold Exchange Au99.99 latest price (CNY/gram) on the extension toolbar badge.

- Data source: `https://en.sge.com.cn/graph/quotations` (same as SGE H5 page backing endpoint)
- Polling interval: 5s (configurable in code; can be extended to options page)

## Install (Developer Mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `chrome-au9999-badge/src`

## Notes

This extension makes direct network requests to SGE. If you prefer “only read from a page you opened”, we can switch to a content-script approach, but the badge would update only while that page is open.
