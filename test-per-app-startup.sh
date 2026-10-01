#!/bin/bash
# test-per-app-startup.sh - اختبار ميزة التشغيل التلقائي لكل تطبيق
# Run this script to verify the per-app startup feature works correctly

echo "=========================================="
echo "  اختبار ميزة التشغيل التلقائي لكل تطبيق"
echo "  Testing Per-App Startup Feature"
echo "=========================================="
echo ""

# Test 1: Check config.json has startup field
echo "Test 1: Checking config.json for startup field..."
if grep -q '"startup"' config.json; then
    echo "  ✅ PASS: startup field exists in config.json"
else
    echo "  ❌ FAIL: startup field missing from config.json"
    exit 1
fi

# Test 2: Check server.js has syncStartupApps function
echo "Test 2: Checking server.js for syncStartupApps function..."
if grep -q "function syncStartupApps" server.js; then
    echo "  ✅ PASS: syncStartupApps function exists"
else
    echo "  ❌ FAIL: syncStartupApps function missing"
    exit 1
fi

# Test 3: Check server.js has POST /api/apps/:id/startup endpoint
echo "Test 3: Checking server.js for startup API endpoint..."
if grep -q "/startup.*req.method === 'POST'" server.js; then
    echo "  ✅ PASS: startup API endpoint exists"
else
    echo "  ❌ FAIL: startup API endpoint missing"
    exit 1
fi

# Test 4: Check index.html has toggleAppStartup function
echo "Test 4: Checking index.html for toggleAppStartup function..."
if grep -q "function toggleAppStartup" public/index.html; then
    echo "  ✅ PASS: toggleAppStartup function exists"
else
    echo "  ❌ FAIL: toggleAppStartup function missing"
    exit 1
fi

# Test 5: Check index.html has app-startup-toggle class
echo "Test 5: Checking index.html for app-startup-toggle CSS..."
if grep -q "app-startup-toggle" public/index.html; then
    echo "  ✅ PASS: app-startup-toggle CSS exists"
else
    echo "  ❌ FAIL: app-startup-toggle CSS missing"
    exit 1
fi

echo ""
echo "=========================================="
echo "  All basic checks passed! ✅"
echo "=========================================="
echo ""
echo "To test the full cycle:"
echo "1. Start the server: node server.js"
echo "2. Open http://localhost:3769"
echo "3. Click the toggle switch on any app"
echo "4. Restart the server"
echo "5. Verify the app runs automatically"
echo ""
