let map = null;
let markers = []; // Store map markers for selection
let routeGroups = new Map(); // Store routes by point pair (key: "startName-endName")
let polylineHistory = new Map(); // Store polyline states for undo
let lastMovedSegmentKey = null; // Track last moved polyline
let proposedLengthGlobal = 0; // Track proposed length globally
let globalData = null; // Store data globally for KML download

document.getElementById('uploadForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const formData = new FormData(this);

    // Hide splash image, show map
    document.getElementById('splash-image').style.display = 'none';
    document.getElementById('map').style.display = 'block';

    if (map) map.remove();

    // Start with India map
    map = L.map('map').setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // Create custom control for line summary
    const SummaryControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function (map) {
            const div = L.DomUtil.create('div', 'leaflet-control-summary');
            div.innerHTML = `
                <h4>Line Summary</h4>
                <p id="summary-content">No data yet</p>
                <button id="undo-move-btn" disabled>Undo Last Move</button>
            `;
            L.DomEvent.disableClickPropagation(div); // Prevent map clicks on control
            return div;
        }
    });
    map.addControl(new SummaryControl());

    try {
        console.log('Submitting form...');
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const data = await response.json();
        globalData = data; // Store for KML download
        console.log('Server response, loop length:', data.loop.length);

        const plottedSegments = new Set();
        const blockCoords = [];
        let existingLength = 0;
        proposedLengthGlobal = 0;

        // Clear previous markers and routes
        markers.forEach(marker => map.removeLayer(marker));
        markers = [];
        routeGroups.clear();
        polylineHistory.clear();
        lastMovedSegmentKey = null;

        data.loop.forEach((to, index) => {
            if (index === 0) return;
            const from = data.loop[index - 1];
            const segmentKey = `${from.name}-${to.name}`.toLowerCase();

            if (plottedSegments.has(segmentKey)) {
                console.warn(`Duplicate skipped: ${segmentKey}`);
                return;
            }

            // Validate coordinates
            const fromValid = Array.isArray(from.coordinates) && from.coordinates.length >= 2 && 
                             typeof from.coordinates[0] === 'number' && !isNaN(from.coordinates[0]) &&
                             typeof from.coordinates[1] === 'number' && !isNaN(from.coordinates[1]);
            const toValid = Array.isArray(to.coordinates) && to.coordinates.length >= 2 && 
                           typeof to.coordinates[0] === 'number' && !isNaN(to.coordinates[0]) &&
                           typeof to.coordinates[1] === 'number' && !isNaN(to.coordinates[1]);

            if (!fromValid || !toValid) {
                console.warn(`Skipping ${segmentKey} - invalid point coordinates: from=${from.coordinates}, to=${to.coordinates}`);
                return;
            }

            const rawCoords = to.route?.features?.[0]?.geometry?.coordinates || [from.coordinates, to.coordinates];
            let coords = [];

            if (!Array.isArray(rawCoords)) {
                console.warn(`Raw coords not an array for ${segmentKey}:`, rawCoords);
                return;
            }

            if (Array.isArray(rawCoords[0])) {
                coords = rawCoords.map((coord, i) => {
                    const [lng, lat] = Array.isArray(coord) ? coord : [null, null];
                    if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat)) {
                        console.warn(`Invalid coord at index ${i} in ${segmentKey}: [${lng}, ${lat}]`);
                        return null;
                    }
                    return [lat, lng];
                }).filter(coord => coord !== null);
            } else if (rawCoords.length === 2 && Array.isArray(rawCoords[0]) && Array.isArray(rawCoords[1])) {
                coords = rawCoords.map(([lng, lat]) => {
                    if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat)) {
                        console.warn(`Invalid fallback coord for ${segmentKey}: [${lng}, ${lat}]`);
                        return null;
                    }
                    return [lat, lng];
                }).filter(coord => coord !== null);
            } else {
                console.warn(`Invalid coords format for ${segmentKey}:`, rawCoords);
                return;
            }

            if (coords.length < 2) {
                console.warn(`Skipping ${segmentKey} - too few valid coords:`, coords);
                return;
            }

            // Check for unique coordinates
            const uniqueCoords = coords.filter((coord, i, arr) => 
                i === 0 || coord[0] !== arr[i-1][0] || coord[1] !== arr[i-1][1]
            );
            if (uniqueCoords.length < 2) {
                console.warn(`Skipping ${segmentKey} - no unique coordinates:`, coords);
                return;
            }

            coords.forEach(coord => blockCoords.push(coord));

            const color = to.connection?.color || '#00FFFF';
            const isExisting = to.connection?.existing || false;

            if (to.connection?.length) {
                if (isExisting) {
                    existingLength += to.connection.length;
                } else {
                    proposedLengthGlobal += to.connection.length;
                }
            }

            const polyline = L.polyline(coords, {
                color: color,
                weight: 6,
                opacity: 1,
                dashArray: isExisting ? null : '5, 5',
            }).addTo(map);

            const startPoint = coords[0];
            const endPoint = coords[coords.length - 1];

            const midIndex = Math.floor(coords.length / 2);
            const midPoint = coords[midIndex];

            let dragMarker = null;
            let distanceLabel = null;

            if (!isExisting) {
                dragMarker = L.marker(midPoint, {
                    draggable: true,
                    icon: L.divIcon({
                        className: 'drag-marker',
                        html: '<div style="width: 10px; height: 10px; background: #00FFFF; border-radius: 50%; border: 1px solid white;"></div>',
                        iconSize: [10, 10],
                    }),
                }).addTo(map);

                // Store original state for undo
                const offsetIndex = Math.floor(coords.length * 0.25);
                const offsetPoint = coords[offsetIndex] || midPoint;
                polylineHistory.set(segmentKey, {
                    original: {
                        coords: coords.slice(), // Deep copy
                        distance: to.connection?.length || 0,
                        markerPos: midPoint.slice(),
                        labelPos: offsetPoint.slice(),
                        labelText: to.connection?.length ? `${to.connection.length.toFixed(2)} km` : ''
                    },
                    undoStack: [],
                    polyline,
                    dragMarker,
                    distanceLabel: null,
                    segmentData: to // Store `to` for distance updates
                });
            }

            if (to.connection?.length) {
                const offsetIndex = Math.floor(coords.length * 0.25);
                const offsetPoint = coords[offsetIndex] || midPoint;
                distanceLabel = L.marker(offsetPoint, {
                    icon: L.divIcon({
                        className: 'distance-label',
                        html: `${to.connection.length.toFixed(2)} km`,
                    }),
                }).addTo(map);
                if (!isExisting) {
                    polylineHistory.get(segmentKey).distanceLabel = distanceLabel;
                }
            }

            if (dragMarker) {
                dragMarker.on('dragend', async function (e) {
                    const newPos = e.target.getLatLng();
                    const routeUrl = `http://router.project-osrm.org/route/v1/driving/${startPoint[1]},${startPoint[0]};${newPos.lng},${newPos.lat};${endPoint[1]},${endPoint[0]}?overview=full&geometries=geojson`;
                    console.log('Dragging to:', newPos, 'Fetching route:', routeUrl);

                    // Save current state before updating
                    const history = polylineHistory.get(segmentKey);
                    const markerLatLng = dragMarker.getLatLng();
                    const labelLatLng = distanceLabel ? distanceLabel.getLatLng() : null;
                    history.undoStack.push({
                        coords: polyline.getLatLngs().slice(),
                        distance: history.segmentData.connection?.length || 0,
                        markerPos: [markerLatLng.lat, markerLatLng.lng],
                        labelPos: labelLatLng ? [labelLatLng.lat, labelLatLng.lng] : history.original.labelPos,
                        labelText: distanceLabel ? distanceLabel.getIcon().options.html : history.original.labelText
                    });
                    lastMovedSegmentKey = segmentKey;

                    // Enable undo button
                    const undoBtn = document.getElementById('undo-move-btn');
                    if (undoBtn) undoBtn.disabled = false;

                    try {
                        const routeResponse = await fetch(routeUrl);
                        if (!routeResponse.ok) throw new Error(`Routing API error: ${routeResponse.status}`);

                        const routeData = await routeResponse.json();
                        if (routeData.code === 'Ok' && routeData.routes.length > 0) {
                            const routeCoords = routeData.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
                           
                            polyline.setLatLngs(routeCoords);

                            const distanceMeters = routeData.routes[0].distance;
                            const distanceKm = distanceMeters / 1000;
                  

                            if (history.segmentData.connection?.length) {
                                proposedLengthGlobal -= history.segmentData.connection.length;
                                proposedLengthGlobal += distanceKm;
                                history.segmentData.connection.length = distanceKm;
                            }

                            const midIndexNew = Math.floor(routeCoords.length / 2);
                            const newMidPoint = routeCoords[midIndexNew];
                            dragMarker.setLatLng(newMidPoint);

                            const newOffsetIndex = Math.floor(routeCoords.length * 0.25);
                            const newOffsetPoint = routeCoords[newOffsetIndex] || newMidPoint;
                            if (distanceLabel) {
                                distanceLabel.setLatLng(newOffsetPoint);
                                distanceLabel.setIcon(L.divIcon({
                                    className: 'distance-label',
                                    html: `${distanceKm.toFixed(2)} km`,
                                }));
                            } else {
                                distanceLabel = L.marker(newOffsetPoint, {
                                    icon: L.divIcon({
                                        className: 'distance-label',
                                        html: `${distanceKm.toFixed(2)} km`,
                                    }),
                                }).addTo(map);
                                history.distanceLabel = distanceLabel;
                            }

                            document.getElementById('summary-content').innerHTML = `
                                <div><span class="line-indicator existing-line"></span>Existing Lines: ${existingLength.toFixed(2)} km</div>
                                <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
                            `;
                        } else {
                            console.warn(`No route found for ${segmentKey}:`, routeData.message);
                        }
                    } catch (err) {
                        console.error(`Routing error for ${segmentKey}:`, err);
                        document.getElementById('result').innerHTML = `<p>Error rerouting: ${err.message}</p>`;
                    }
                });
            }

            if (!isExisting) polyline.bringToBack();
            else polyline.bringToFront();

            plottedSegments.add(segmentKey);
        });

        data.loop.forEach(point => {
            if (Array.isArray(point.coordinates) && point.coordinates.length >= 2 && 
                typeof point.coordinates[0] === 'number' && !isNaN(point.coordinates[0]) && 
                typeof point.coordinates[1] === 'number' && !isNaN(point.coordinates[1])) {
                const isMainPoint = point.name === data.mainPointName;
                console.log(`Adding marker: ${point.name}, Main: ${isMainPoint}, Coords: [${point.coordinates[1]}, ${point.coordinates[0]}]`);
                const marker = L.marker([point.coordinates[1], point.coordinates[0]], {
                    icon: isMainPoint ? L.icon({
                        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
                        iconRetinaUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
                        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                        iconSize: [25, 41],
                        iconAnchor: [12, 41],
                        popupAnchor: [1, -34],
                        shadowSize: [41, 41]
                    }) : L.icon({
                        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
                        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                        iconSize: [25, 41],
                        iconAnchor: [12, 41],
                        popupAnchor: [1, -34],
                        shadowSize: [41, 41]
                    })
                });
                marker.pointName = point.name; // Store name for display
                marker.addTo(map);
                markers.push(marker);
                blockCoords.push([point.coordinates[1], point.coordinates[0]]);
            } else {
                console.warn(`Skipping marker for ${point.name} - invalid coordinates:`, point.coordinates);
            }
        });

        // Attach marker listeners immediately
       
        setupMarkerListeners();

        if (blockCoords.length) {
            map.fitBounds(L.latLngBounds(blockCoords), { padding: [50, 50] });
          
        } else {
            console.warn('No valid coordinates to zoom to block');
        }

        // Update summary control
        document.getElementById('summary-content').innerHTML = `
            <div><span class="line-indicator existing-line"></span>Existing Lines: ${existingLength.toFixed(2)} km</div>
            <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
        `;

        document.getElementById('result').innerHTML = `
            <p>Total Length: ${data.totalLength.toFixed(2)} km</p>
            <p>Main Point: ${data.mainPointName}</p>
            <p>Loop Complete: ${data.complete}</p>
        `;

        // Attach undo button handler
        const undoBtn = document.getElementById('undo-move-btn');
        if (undoBtn) {
        
            undoBtn.addEventListener('click', () => {
                if (!lastMovedSegmentKey || !polylineHistory.has(lastMovedSegmentKey)) {
                    document.getElementById('result').innerHTML = `<p>Nothing to undo</p>`;
                    return;
                }

                const history = polylineHistory.get(lastMovedSegmentKey);
                let state = history.undoStack.pop() || history.original;

                // Restore polyline
                history.polyline.setLatLngs(state.coords);

                // Recalculate marker position (midpoint of reverted route)
                const midIndex = Math.floor(state.coords.length / 2);
                const newMidPoint = state.coords[midIndex] || state.markerPos;
                history.dragMarker.setLatLng(newMidPoint);
                console.log(`Moved marker back to: [${newMidPoint[0]}, ${newMidPoint[1]}]`);

                // Restore label
                if (history.distanceLabel) {
                    history.distanceLabel.setLatLng(state.labelPos);
                    history.distanceLabel.setIcon(L.divIcon({
                        className: 'distance-label',
                        html: state.labelText
                    }));
                }

                // Update proposed length
                if (state.distance) {
                    proposedLengthGlobal -= history.segmentData.connection.length;
                    proposedLengthGlobal += state.distance;
                    history.segmentData.connection.length = state.distance;
                }

                // Update summary
                document.getElementById('summary-content').innerHTML = `
                    <div><span class="line-indicator existing-line"></span>Existing Lines: ${existingLength.toFixed(2)} km</div>
                    <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
                `;

                // Feedback
                document.getElementById('result').innerHTML = `<p>Undo successful for ${lastMovedSegmentKey}</p>`;

                // Disable button if no more undos
                if (history.undoStack.length === 0) {
                    undoBtn.disabled = true;
                    lastMovedSegmentKey = null;
                }
            });
        }
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('result').innerHTML = `<p>Error: ${error.message}</p>`;
        document.getElementById('summary-content').innerHTML = 'Error loading data';
    }
});

// Download KML handler
document.getElementById('downloadKml').addEventListener('click', () => {
    if (!globalData || !map) {
        document.getElementById('result').innerHTML = `<p>Error: No map data to download</p>`;
        console.warn('No data or map available for KML download');
        return;
    }

    console.log('Generating KML for download...');
    let skippedConnections = 0;
    let missingDistances = 0;

    // Determine block/district name from main point
    let blockName = 'block';
    if (globalData.mainPointName) {
        // Extract block name, e.g., "Kharagpur-I" from "Kharagpur-I BHQ"
        blockName = globalData.mainPointName.split(' ')[0].replace(/[^a-zA-Z0-9-]/g, '');
        console.log(`Using block name from main point: ${blockName}`);
    } else {
        console.warn('No mainPointName found, using default block name');
    }

    // Start KML document
    let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
    <name>${blockName} Routes</name>
    <description>Exported routes for ${blockName}</description>
`;

    // Define styles
    kml += `
    <Style id="mainPoint">
        <IconStyle>
            <Icon>
                <href>https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png</href>
            </Icon>
        </IconStyle>
    </Style>
    <Style id="normalPoint">
        <IconStyle>
            <Icon>
                <href>https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png</href>
            </Icon>
        </IconStyle>
    </Style>
    <Style id="existingLine">
        <LineStyle>
            <color>ff00ffff</color>
            <width>4</width>
            <colorMode>normal</colorMode>
        </LineStyle>
        <LabelStyle>
            <color>ff00ffff</color>
            <scale>1</scale>
        </LabelStyle>
    </Style>
    <Style id="proposedLine">
        <LineStyle>
            <color>ff00ffff</color>
            <width>4</width>
            <colorMode>normal</colorMode>
        </LineStyle>
        <LabelStyle>
            <color>ff00ffff</color>
            <scale>1</scale>
        </LabelStyle>
        <PolyStyle>
            <fill>0</fill>
        </PolyStyle>
    </Style>
    <Style id="alternateRoute">
        <LineStyle>
            <color>008000</color>
            <width>4</width>
            <colorMode>normal</colorMode>
        </LineStyle>
        <LabelStyle>
            <color>008000</color>
            <scale>1</scale>
        </LabelStyle>
    </Style>
    <Style id="distanceLabel">
        <IconStyle>
            <scale>0</scale>
        </IconStyle>
        <LabelStyle>
            <color>ffffffff</color>
            <scale>1</scale>
        </LabelStyle>
    </Style>
`;

    // Add points
    globalData.loop.forEach(point => {
        if (Array.isArray(point.coordinates) && point.coordinates.length >= 2 && 
            typeof point.coordinates[0] === 'number' && !isNaN(point.coordinates[0]) && 
            typeof point.coordinates[1] === 'number' && !isNaN(point.coordinates[1])) {
            const isMainPoint = point.name === globalData.mainPointName;
            kml += `
    <Placemark>
        <name>${point.name}</name>
        <description>Point: ${point.name}${isMainPoint ? ' (Main Point)' : ''}</description>
        <styleUrl>#${isMainPoint ? 'mainPoint' : 'normalPoint'}</styleUrl>
        <Point>
            <coordinates>${point.coordinates[0]},${point.coordinates[1]}</coordinates>
        </Point>
    </Placemark>`;
        } else {
            console.warn(`Skipping point ${point.name} in KML - invalid coordinates:`, point.coordinates);
        }
    });

    // Add connections
    globalData.loop.forEach((to, index) => {
        if (index === 0) return;
        const from = globalData.loop[index - 1];
        const segmentKey = `${from.name}-${to.name}`.toLowerCase();
        let coords = [];

        // Validate point coordinates
        const fromValid = Array.isArray(from.coordinates) && from.coordinates.length >= 2 && 
                         typeof from.coordinates[0] === 'number' && !isNaN(from.coordinates[0]) &&
                         typeof from.coordinates[1] === 'number' && !isNaN(from.coordinates[1]);
        const toValid = Array.isArray(to.coordinates) && to.coordinates.length >= 2 && 
                       typeof to.coordinates[0] === 'number' && !isNaN(to.coordinates[0]) &&
                       typeof to.coordinates[1] === 'number' && !isNaN(to.coordinates[1]);

        if (!fromValid || !toValid) {
            console.warn(`Skipping KML connection ${segmentKey} - invalid point coordinates: from=${from.coordinates}, to=${to.coordinates}`);
            skippedConnections++;
            return;
        }

        // Use edited coords from polylineHistory if available
        if (polylineHistory.has(segmentKey)) {
            const history = polylineHistory.get(segmentKey);
            coords = history.polyline.getLatLngs().map(latLng => [latLng.lat, latLng.lng]);
        } else {
            const rawCoords = to.route?.features?.[0]?.geometry?.coordinates || [from.coordinates, to.coordinates];
            if (Array.isArray(rawCoords[0])) {
                coords = rawCoords.map(([lng, lat]) => {
                    if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat)) {
                        return null;
                    }
                    return [lat, lng];
                }).filter(coord => coord !== null);
            } else if (rawCoords.length === 2 && Array.isArray(rawCoords[0]) && Array.isArray(rawCoords[1])) {
                coords = rawCoords.map(([lng, lat]) => {
                    if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat)) {
                        return null;
                    }
                    return [lat, lng];
                }).filter(coord => coord !== null);
            } else {
                console.warn(`Invalid raw coords for ${segmentKey}:`, rawCoords);
                skippedConnections++;
                return;
            }
        }

        // Validate coords
        if (coords.length < 2) {
            console.warn(`Skipping KML connection ${segmentKey} - too few coords:`, coords);
            skippedConnections++;
            return;
        }

        // Ensure unique coordinates
        const uniqueCoords = coords.filter((coord, i, arr) => 
            i === 0 || coord[0] !== arr[i-1][0] || coord[1] !== arr[i-1][1]
        );
        if (uniqueCoords.length < 2) {
            console.warn(`Skipping KML connection ${segmentKey} - no unique coordinates:`, coords);
            skippedConnections++;
            return;
        }

        const isExisting = to.connection?.existing || false;
        const distance = to.connection?.length;
        const distanceText = distance ? `${distance.toFixed(2)} km` : 'Unknown';
        if (!distance) {
            console.warn(`Missing distance for ${segmentKey}`);
            missingDistances++;
        }



        // Add LineString
        kml += `
    <Placemark>
        <name>${from.name} to ${to.name} (${distanceText})</name>
        <description>Distance: ${distanceText}, Type: ${isExisting ? 'Existing' : 'Proposed'}</description>
        <styleUrl>#${isExisting ? 'existingLine' : 'proposedLine'}</styleUrl>
        <LineString>
            <coordinates>
                ${uniqueCoords.map(coord => `${coord[1]},${coord[0]}`).join('\n                ')}
            </coordinates>
        </LineString>
    </Placemark>`;

        // Add distance label at midpoint
        if (distance) {
            const midIndex = Math.floor(uniqueCoords.length / 2);
            const midPoint = uniqueCoords[midIndex];
            kml += `
    <Placemark>
        <name>${distanceText}</name>
        <description>Distance for ${from.name} to ${to.name}</description>
        <styleUrl>#distanceLabel</styleUrl>
        <Point>
            <coordinates>${midPoint[1]},${midPoint[0]}</coordinates>
        </Point>
    </Placemark>`;
        }
    });

    // Add alternate routes
    routeGroups.forEach((group, routeKey) => {
        group.layers.forEach((layer, index) => {
            if (layer instanceof L.Polyline) {
                const coords = layer.getLatLngs();
                // Validate coords
                if (!coords || coords.length < 2) {
                    console.warn(`Skipping alternate route ${routeKey} Route ${index + 1} - too few coords:`, coords);
                    return;
                }
                const uniqueCoords = coords.filter((coord, i, arr) => 
                    i === 0 || (coord.lat !== arr[i-1].lat || coord.lng !== arr[i-1].lng)
                );
                if (uniqueCoords.length < 2) {
                    console.warn(`Skipping alternate route ${routeKey} Route ${index + 1} - no unique coordinates:`, coords);
                    return;
                }
                // Find distance from resultHtml
                let distance = null;
                const match = group.resultHtml.match(/Route ${index + 1}.*?: (\d+\.\d{2}) km/);
                if (match) {
                    distance = parseFloat(match[1]);
                }
                const distanceText = distance ? `${distance.toFixed(2)} km` : 'Unknown';
                if (!distance) {
                    console.warn(`Missing distance for alternate route ${routeKey} Route ${index + 1}`);
                    missingDistances++;
                }
                console.log(`KML alternate route ${routeKey} Route ${index + 1} coords:`, uniqueCoords, `Distance: ${distanceText}, Style: alternateRoute`);

                // Add LineString
                kml += `
    <Placemark>
        <name>${routeKey} Route ${index + 1} (${distanceText})</name>
        <description>Distance: ${distanceText}, Type: Alternate Route</description>
        <styleUrl>#alternateRoute</styleUrl>
        <LineString>
            <coordinates>
                ${uniqueCoords.map(coord => `${coord.lng},${coord.lat}`).join('\n                ')}
            </coordinates>
        </LineString>
    </Placemark>`;

                // Add distance label at midpoint
                if (distance) {
                    const midIndex = Math.floor(uniqueCoords.length / 2);
                    const midPoint = uniqueCoords[midIndex];
                    kml += `
    <Placemark>
        <name>${distanceText}</name>
        <description>Distance for ${routeKey} Route ${index + 1}</description>
        <styleUrl>#distanceLabel</styleUrl>
        <Point>
            <coordinates>${midPoint[1]},${midPoint[0]}</coordinates>
        </Point>
    </Placemark>`;
                }
            }
        });
    });

    // Close KML
    kml += `
</Document>
</kml>`;

    // Trigger download
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${blockName}-routes.kml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    let resultMsg = `<p>KML file downloaded as ${blockName}-routes.kml</p>`;
    if (skippedConnections > 0) {
        resultMsg += `<p>Warning: ${skippedConnections} connection(s) skipped due to invalid coordinates</p>`;
    }
    if (missingDistances > 0) {
        resultMsg += `<p>Warning: ${missingDistances} route(s) missing distance data</p>`;
    }
    document.getElementById('result').innerHTML = resultMsg;
    console.log('KML download initiated, file: ', `${blockName}-routes.kml`, 'skipped connections:', skippedConnections, 'missing distances:', missingDistances);
});

// Route selection logic
let startPoint = null, endPoint = null, startPointName = null, endPointName = null;
const routeBox = document.getElementById('route-box');
const startPointDisplay = document.getElementById('start-point');
const endPointDisplay = document.getElementById('end-point');
const calculateRouteBtn = document.getElementById('calculate-route-btn');
const routeLoading = document.getElementById('route-loading');

// Show route box
document.getElementById('show-route-btn').addEventListener('click', () => {
    if (!map || markers.length === 0) {
        alert('Please upload KML files and generate the map first.');
        return;
    }
    console.log('Showing route box, markers available:', markers.length);
    routeBox.style.display = 'block';
    startPoint = null;
    endPoint = null;
    startPointName = null;
    endPointName = null;
    startPointDisplay.textContent = 'Not selected';
    endPointDisplay.textContent = 'Not selected';
    calculateRouteBtn.disabled = true;
    setupMarkerListeners(); // Re-attach listeners
});

// Close route box
document.getElementById('close-box-btn').addEventListener('click', () => {
    console.log('Closing route box');
    routeBox.style.display = 'none';
    startPoint = null;
    endPoint = null;
    startPointName = null;
    endPointName = null;
    startPointDisplay.textContent = 'Not selected';
    endPointDisplay.textContent = 'Not selected';
    calculateRouteBtn.disabled = true;
    // Restore popups
    markers.forEach(marker => {
        if (marker.pointName) {
            marker.bindPopup(marker.pointName);
        }
    });
});

// Clear all routes
function clearAllRoutes() {
    routeGroups.forEach(group => {
        group.layers.forEach(layer => map.removeLayer(layer));
    });
    routeGroups.clear();
    document.getElementById('result').innerHTML = '';
    document.getElementById("start-point").innerHTML = '',
    document.getElementById("end-point").innerHTML = '' // Clear result display
}

// Handle marker clicks for start and end points
function setupMarkerListeners() {
    console.log('Setting up marker listeners for', markers.length, 'markers');
    markers.forEach((marker, index) => {
        marker.off('click'); // Clear existing listeners
        marker.on('click', () => {
            if (routeBox.style.display !== 'block') {
                console.log('Marker clicked but route box is not open, showing popup');
                return;
            }
            const latlng = marker.getLatLng();
            console.log(`Marker ${index} clicked: ${marker.pointName} at [${latlng.lat}, ${latlng.lng}]`);
            if (!startPoint) {
                startPoint = latlng;
                startPointName = marker.pointName;
                startPointDisplay.textContent = `${marker.pointName} (Lat: ${latlng.lat.toFixed(5)}, Lng: ${latlng.lng.toFixed(5)})`;
                console.log('Set start point:', marker.pointName, startPoint);
            } else if (!endPoint && (latlng.lat !== startPoint.lat || latlng.lng !== startPoint.lng)) {
                endPoint = latlng;
                endPointName = marker.pointName;
                endPointDisplay.textContent = `${marker.pointName} (Lat: ${latlng.lat.toFixed(5)}, Lng: ${latlng.lng.toFixed(5)})`;
                console.log('Set end point:', marker.pointName, endPoint);
            } else {
                console.log('Invalid selection: same point or end point already set');
            }
            if (startPoint && endPoint) {
                calculateRouteBtn.disabled = false;
                console.log('Both points selected, enabling Calculate Route button');
            }
        });
        // Disable popups during selection
        if (routeBox.style.display === 'block') {
            marker.unbindPopup();
        } else if (marker.pointName) {
            marker.bindPopup(marker.pointName);
        }
    });
}

// Calculate route
document.getElementById('calculate-route-btn').addEventListener('click', async () => {
    if (!startPoint || !endPoint || !startPointName || !endPointName) {
        console.log('Calculate Route clicked but points not selected');
        return;
    }
    console.log('Calculating routes from', startPointName, 'to', endPointName);

    // Show loading state
    if (routeLoading) {
        routeLoading.style.display = 'block';
    }

    // Fetch routes from /show-route API
    const fetchRoutes = async () => {
        try {
            const url = `/show-route?lat1=${startPoint.lat}&lng1=${startPoint.lng}&lat2=${endPoint.lat}&lng2=${endPoint.lng}`;
            console.log('Fetching routes:', url);
            const response = await fetch(url);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error: ${response.status}`);
            }
            const data = await response.json();
            console.log('Routes received:', data);
            return Array.isArray(data) ? data : [data]; // Fallback for single route
        } catch (error) {
            console.error('Routes fetch error:', error);
            throw error;
        }
    };

    try {
        // Fetch routes (single call returns array)
        const routes = (await fetchRoutes()).slice(0, 3); // Limit to 3 routes

        // Create a unique key for this point pair
        const routeKey = `${startPointName}-${endPointName}`.toLowerCase();

        // Remove existing routes for this point pair (if any)
        if (routeGroups.has(routeKey)) {
            routeGroups.get(routeKey).layers.forEach(layer => map.removeLayer(layer));
            routeGroups.delete(routeKey);
        }

        // Display routes
        const colors = ['#808080', '#808080', '#808080'];
        let resultHtml = `<h4>Routes for ${startPointName} to ${endPointName}</h4>`;
        const routeLayers = [];

        routes.forEach((routeData, index) => {
            if (routeData.route && Array.isArray(routeData.route)) {
                const route = L.polyline(routeData.route, {
                    color: colors[index],
                    weight: 6,
                    opacity: 0.8,
                }).addTo(map);
                routeLayers.push(route);
                console.log(`Added route ${index + 1}: ${routeData.distance.toFixed(2)} km`);

                // Add distance label on polyline
                const offsetIndex = Math.floor(routeData.route.length * 0.25);
                const offsetPoint = routeData.route[offsetIndex] || routeData.route[Math.floor(routeData.route.length / 2)];
                const distanceLabel = L.marker(offsetPoint, {
                    icon: L.divIcon({
                        className: 'distance-label',
                        html: `${routeData.distance.toFixed(2)} km`,
                    }),
                }).addTo(map);
                routeLayers.push(distanceLabel); // Include label for cleanup

                resultHtml += `<p>Route ${index + 1} (<span style="color: ${colors[index]}">■</span>): ${routeData.distance.toFixed(2)} km</p>`;
            } else {
                console.warn(`Invalid route data at index ${index}:`, routeData);
                resultHtml += `<p>Route ${index + 1}: Failed to load</p>`;
            }
        });

        // Store the route group
        routeGroups.set(routeKey, { layers: routeLayers, resultHtml });

        // Update result display (show all routes)
        const resultDiv = document.getElementById('result');
        resultDiv.innerHTML = Array.from(routeGroups.entries())
            .map(([key, group]) => group.resultHtml)
            .join('<br>');

        // Zoom to fit all routes for this point pair
        const allRouteCoords = routes.flatMap(r => r.route || []);
        if (allRouteCoords.length) {
            map.fitBounds(L.latLngBounds(allRouteCoords), { padding: [50, 50] });
            console.log('Zoomed to routes:', allRouteCoords.length, 'points');
        } else {
            console.warn('No valid route coordinates to zoom');
        }
    } catch (error) {
        console.error('Error displaying routes:', error);
        document.getElementById('result').innerHTML = `<p>Error: ${error.message}</p>`;
    } finally {
        if (routeLoading) {
            routeLoading.style.display = 'none';
        }
    }
});

// Add Clear All Routes button dynamically (if not in HTML)
if (document.getElementById('clear-routes-btn')) {
    const clearRoutesBtn = document.getElementById('clear-routes-btn')
    clearRoutesBtn.id = 'clear-routes-btn';
    clearRoutesBtn.textContent = 'Clear All Routes';
    clearRoutesBtn.addEventListener('click', () => {
        console.log('Clearing all routes');
        clearAllRoutes();
    });
    routeBox.appendChild(clearRoutesBtn);
}