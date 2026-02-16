
let map = null;
let markers = [];
let routeGroups = new Map();
let polylineHistory = new Map();
let lastMovedSegmentKey = null;
let proposedLengthGlobal = 0;
let globalData = { loop: [], mainPointName: null, totalLength: 0, complete: false };
let pointsUploaded = false;
let selectedPolyline = null;
let selectedSegmentKey = null;
let searchMarker = null;
let directionsService = null;
let placesService = null;

function initMap() {
    map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: 20.5937, lng: 78.9629 },
        zoom: 5,
        mapTypeId: 'roadmap',
    });

    directionsService = new google.maps.DirectionsService();
    placesService = new google.maps.places.PlacesService(map);

    document.getElementById('splash-image').style.display = 'none';
    document.getElementById('map').style.display = 'block';

    const summaryControl = document.createElement('div');
    summaryControl.className = 'leaflet-control-summary';
    summaryControl.style.backgroundColor = 'white';
    summaryControl.style.padding = '15px';
    summaryControl.style.border = '2px solid rgba(0,0,0,0.2)';
    summaryControl.style.borderRadius = '10px';
    summaryControl.style.position = 'absolute';
    summaryControl.style.left = '20px';
    summaryControl.style.bottom = '40px';  // Space above map controls
    summaryControl.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
    summaryControl.innerHTML = `
    <h4>Line Summary</h4>
    <p id="summary-content">No data yet</p>
    <button id="undo-move-btn" disabled>Undo</button>
`;

    // Add the control to the map
    map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(summaryControl);


    // Attach undo listener
    const attachUndoListener = () => {
        const undoBtn = document.getElementById('undo-move-btn');
        if (!undoBtn) {
            console.error('Undo button not found in DOM during listener attachment');
            return;
        }
        console.log('Attaching undo listener to #undo-move-btn', undoBtn);

        // Remove existing listeners
        undoBtn.replaceWith(undoBtn.cloneNode(true));
        const newUndoBtn = document.getElementById('undo-move-btn');

        newUndoBtn.addEventListener('click', () => {
            console.log('Undo button clicked', {
                lastMovedSegmentKey,
                hasHistory: polylineHistory.has(lastMovedSegmentKey),
                polylineHistoryKeys: Array.from(polylineHistory.keys())
            });

            if (!lastMovedSegmentKey || !polylineHistory.has(lastMovedSegmentKey)) {
                document.getElementById('result').innerHTML = `<p>Nothing to undo</p>`;
                console.warn('Undo failed: Invalid or missing segment key', {
                    lastMovedSegmentKey,
                    hasHistory: polylineHistory.has(lastMovedSegmentKey)
                });
                return;
            }

            const history = polylineHistory.get(lastMovedSegmentKey);
            console.log('History retrieved', {
                segmentKey: lastMovedSegmentKey,
                polylineExists: !!history.polyline,
                dragMarkersCount: history.dragMarkers?.length || 0
            });

            let state = history.undoStack.pop() || history.original;
            console.log('State to restore', {
                state,
                coordsLength: state.coords?.length,
                undoStackLength: history.undoStack.length
            });

            if (!state || !Array.isArray(state.coords) || state.coords.length < 2) {
                document.getElementById('result').innerHTML = `<p>No valid undo state available</p>`;
                console.warn('Undo failed: Invalid state', { state });
                return;
            }

            try {
                // Validate and update polyline path
                if (history.polyline) {
                    const newPath = state.coords.map((c, i) => {
                        const lat = typeof c.lat === 'number' ? c.lat : (typeof c.lat === 'function' ? c.lat() : null);
                        const lng = typeof c.lng === 'number' ? c.lng : (typeof c.lng === 'function' ? c.lng() : null);
                        if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
                            console.warn(`Invalid coordinate at index ${i}`, { coord: c });
                            return null;
                        }
                        return { lat, lng };
                    }).filter(c => c != null);

                    if (newPath.length < 2) {
                        console.error('Invalid newPath after validation', { newPath });
                        document.getElementById('result').innerHTML = `<p>Error: Invalid coordinates in undo state</p>`;
                        return;
                    }

                    history.polyline.setPath(newPath);
                    console.log('Polyline path updated', { newPathLength: newPath.length, firstCoord: newPath[0] });
                } else {
                    console.error('Polyline missing for segment:', lastMovedSegmentKey);
                    document.getElementById('result').innerHTML = `<p>Error: Polyline not found</p>`;
                    return;
                }

                // Update drag markers
                if (history.dragMarkers && Array.isArray(state.markerPositions)) {
                    history.dragMarkers.forEach((marker, index) => {
                        const pos = state.markerPositions[index];
                        if (pos && Array.isArray(pos) && pos.length === 2 && typeof pos[0] === 'number' && !isNaN(pos[0]) && typeof pos[1] === 'number' && !isNaN(pos[1])) {
                            marker.setPosition({ lat: pos[0], lng: pos[1] });
                            console.log(`Drag marker ${index + 1} moved to`, { lat: pos[0], lng: pos[1] });
                        } else {
                            console.warn(`Invalid marker position for marker ${index + 1}`, { pos });
                            const fraction = [0.25, 0.5, 0.75][index];
                            const posIndex = Math.floor(state.coords.length * fraction);
                            const coord = state.coords[posIndex] || state.coords[Math.floor(state.coords.length / 2)];
                            const lat = typeof coord.lat === 'number' ? coord.lat : (typeof coord.lat === 'function' ? coord.lat() : 0);
                            const lng = typeof coord.lng === 'number' ? coord.lng : (typeof coord.lng === 'function' ? coord.lng() : 0);
                            if (!isNaN(lat) && !isNaN(lng)) {
                                marker.setPosition({ lat, lng });
                                console.log(`Drag marker ${index + 1} fallback to`, { lat, lng });
                            } else {
                                console.warn(`Fallback failed for marker ${index + 1}`, { coord });
                            }
                        }
                    });
                } else {
                    console.warn('No drag markers or invalid markerPositions', {
                        dragMarkers: history.dragMarkers,
                        markerPositions: state.markerPositions
                    });
                }

                // Update distance label
                if (history.distanceLabel && typeof state.distance === 'number' && !isNaN(state.distance)) {
                    history.distanceLabel.setTitle(`${state.distance.toFixed(2)} km`);
                    history.distanceLabel.setLabel({ text: `${state.distance.toFixed(2)} km`, color: 'white', fontSize: '12px' });
                    let labelPos = state.labelPos;
                    if (!labelPos || !Array.isArray(labelPos) || labelPos.length !== 2 || typeof labelPos[0] !== 'number' || isNaN(labelPos[0])) {
                        const offsetIndex = Math.floor(state.coords.length * 0.25);
                        const coord = state.coords[offsetIndex] || state.coords[Math.floor(state.coords.length / 2)];
                        labelPos = [
                            typeof coord.lat === 'number' ? coord.lat : (typeof coord.lat === 'function' ? coord.lat() : 0),
                            typeof coord.lng === 'number' ? coord.lng : (typeof coord.lng === 'function' ? coord.lng() : 0)
                        ];
                        console.warn('Using fallback label position', { labelPos });
                    }
                    if (!isNaN(labelPos[0]) && !isNaN(labelPos[1])) {
                        history.distanceLabel.setPosition({ lat: labelPos[0], lng: labelPos[1] });
                        console.log('Distance label updated', {
                            position: labelPos,
                            text: `${state.distance.toFixed(2)} km`
                        });
                    } else {
                        console.warn('Invalid label position', { labelPos });
                    }
                } else {
                    console.warn('No distance label or invalid distance', {
                        distanceLabel: history.distanceLabel,
                        distance: state.distance
                    });
                }

                // Parse segment key
                let fromName = '';
                let toName = '';
                for (const point of globalData.loop) {
                    if (lastMovedSegmentKey.endsWith(`-${point.name}`)) {
                        toName = point.name;
                        fromName = lastMovedSegmentKey.slice(0, lastMovedSegmentKey.length - point.name.length - 1);
                        break;
                    }
                }

                if (!fromName || !toName) {
                    console.warn(`Invalid segment key format: ${lastMovedSegmentKey}`);
                    document.getElementById('result').innerHTML = `<p>Error: Invalid segment key format</p>`;
                    return;
                }

                // Update globalData.loop
                const endPointIndex = globalData.loop.findIndex(p => p.name === toName);
                if (endPointIndex >= 0) {
                    globalData.loop[endPointIndex].connection = {
                        ...globalData.loop[endPointIndex].connection,
                        length: state.distance
                    };
                    globalData.loop[endPointIndex].route = {
                        features: [{
                            geometry: {
                                coordinates: state.coords.map(c => [
                                    typeof c.lng === 'number' ? c.lng : (typeof c.lng === 'function' ? c.lng() : 0),
                                    typeof c.lat === 'number' ? c.lat : (typeof c.lat === 'function' ? c.lat() : 0)
                                ])
                            }
                        }]
                    };
                    console.log(`Updated globalData.loop for ${toName}`, globalData.loop[endPointIndex]);
                } else {
                    console.warn(`End point ${toName} not found in globalData.loop`);
                }

                // Update segmentData
                if (history.segmentData.connection) {
                    history.segmentData.connection.length = state.distance;
                }

                // Update proposedLengthGlobal
                proposedLengthGlobal = globalData.loop
                    .filter(p => p.connection && !p.connection.existing)
                    .reduce((sum, p) => sum + (p.connection?.length || 0), 0);
                console.log('Updated proposedLengthGlobal:', proposedLengthGlobal);

                // Update summary
                const summaryElement = document.getElementById('summary-content');
                if (summaryElement) {
                    summaryElement.innerHTML = `
                        <div><span class="line-indicator existing-line"></span>Existing Lines: ${globalData.existingLength?.toFixed(2) || 0} km</div>
                        <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
                    `;
                    summaryElement.style.display = 'none';
                    summaryElement.offsetHeight;
                    summaryElement.style.display = 'block';
                    console.log('Summary updated');
                }

                // Disable button if no more states
                if (history.undoStack.length === 0 && !history.original) {
                    newUndoBtn.disabled = true;
                    lastMovedSegmentKey = null;
                    console.log('Undo button disabled, cleared lastMovedSegmentKey');
                }

                document.getElementById('result').innerHTML = `<p>Undo successful for segment ${fromName} to ${toName}</p>`;
            } catch (error) {
                console.error('Undo error:', error);
                document.getElementById('result').innerHTML = `<p>Error during undo: ${error.message}</p>`;
            }
        });
    };

    // Attach listener immediately
    attachUndoListener();

    // Reattach after connections upload
    document.getElementById('uploadConnectionsBtn').addEventListener('click', () => {
        console.log('Connections upload triggered, reattaching undo listener');
        setTimeout(attachUndoListener, 1000); // Delay to ensure DOM updates
    });
}



document.getElementById('search-btn').addEventListener('click', () => {
    const query = document.getElementById('search-input').value.trim();
    if (!query) {
        document.getElementById('result').innerHTML = '<p>Please enter a search query.</p>';
        return;
    }

    if (!map) {
        document.getElementById('result').innerHTML = '<p>Error: Map not initialized.</p>';
        console.error('Map is not initialized');
        return;
    }

    document.getElementById('result').innerHTML = '<p>Searching...</p>';

    const request = {
        query,
        fields: ['name', 'geometry', 'formatted_address'],
    };

    placesService.textSearch(request, (results, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !results) {
            document.getElementById('result').innerHTML = `<p>Error searching: ${status}</p>`;
            console.error('Places search error:', status);
            return;
        }

        console.log('Search results:', results);

        if (results.length === 0) {
            document.getElementById('result').innerHTML = '<p>No results found.</p>';
            return;
        }

        let resultHtml = '<h4>Search Results</h4><ul style="list-style: none; padding: 0; margin: 0;">';
        results.forEach((place, index) => {
            resultHtml += `
                <li style="margin-bottom: 5px;">
                    <a href="#" data-index="${index}" style="color: #1a3c5e; text-decoration: none;">
                        ${place.name} (${place.formatted_address})
                    </a>
                </li>`;
        });
        resultHtml += '</ul>';
        document.getElementById('result').innerHTML = resultHtml;

        document.querySelectorAll('#result a').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const index = parseInt(e.target.getAttribute('data-index'));
                const place = results[index];

                console.log('Selected place:', place);

                const location = place.geometry.location;
                if (!location) {
                    document.getElementById('result').innerHTML = '<p>Error: Invalid coordinates for this location.</p>';
                    console.error('Invalid coordinates:', place.geometry);
                    return;
                }

                if (searchMarker) {
                    searchMarker.setMap(null);
                    console.log('Removed previous search marker');
                }

                try {
                    searchMarker = new google.maps.Marker({
                        position: location,
                        map,
                        zIndex: 1000,
                    });

                    console.log('Marker added at:', location);

                    const infoWindow = new google.maps.InfoWindow({
                        content: `
                            <b>${place.name}</b><br>
                            ${place.formatted_address}<br>
                            Lat: ${location.lat().toFixed(5)}, Lng: ${location.lng().toFixed(5)}
                        `,
                    });
                    infoWindow.open(map, searchMarker);

                    map.setCenter(location);
                    map.setZoom(15);
                    console.log('Map zoomed to:', location, 'Zoom level: 15');

                    document.getElementById('result').innerHTML = `
                        <p>Selected: ${place.name} (${place.formatted_address})</p>
                        <p>Lat: ${location.lat().toFixed(5)}, Lng: ${location.lng().toFixed(5)}</p>
                    `;
                } catch (error) {
                    document.getElementById('result').innerHTML = '<p>Error adding marker to map.</p>';
                    console.error('Error creating marker:', error);
                }
            });
        });
    });
});

document.getElementById('uploadPointsBtn').addEventListener('click', async () => {
    const pointsFile = document.getElementById('pointsFile').files[0];
    if (!pointsFile) {
        document.getElementById('result').innerHTML = '<p>Please select a points KML file.</p>';
        return;
    }

    const formData = new FormData();
    formData.append('pointsFile', pointsFile);

    const pointsLoading = document.getElementById('points-loading');
    const uploadPointsBtn = document.getElementById('uploadPointsBtn');
    pointsLoading.style.display = 'block';
    uploadPointsBtn.disabled = true;

    try {
        console.log('Uploading points...');
        const response = await fetch('/upload-points', {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const data = await response.json();

        markers.forEach(marker => marker.setMap(null));
        markers = [];

        globalData.loop = data.points || [];
        globalData.mainPointName = data.mainPointName || null;
        const blockCoords = [];

        const iconMap = {
            '#style1': 'https://maps.gstatic.com/mapfiles/ms2/micons/purple-dot.png',
            '#style2': 'https://maps.gstatic.com/mapfiles/ms2/micons/red-dot.png',
            '#style3': 'https://maps.gstatic.com/mapfiles/ms2/micons/green-dot.png',
            '#style4': 'https://maps.gstatic.com/mapfiles/ms2/micons/purple-dot.png',
            '#style5': 'https://maps.gstatic.com/mapfiles/ms2/micons/red-dot.png',
        };

        globalData.loop.forEach(point => {
            if (
                Array.isArray(point.coordinates) &&
                point.coordinates.length >= 2 &&
                typeof point.coordinates[0] === 'number' && !isNaN(point.coordinates[0]) &&
                typeof point.coordinates[1] === 'number' && !isNaN(point.coordinates[1])
            ) {
                const isMainPoint = point.name === globalData.mainPointName;
                const iconUrl = point.styleUrl && iconMap[point.styleUrl]
                    ? iconMap[point.styleUrl]
                    : isMainPoint
                        ? 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png'
                        : 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png';

                const marker = new google.maps.Marker({
                    position: { lat: point.coordinates[1], lng: point.coordinates[0] },
                    map,
                    icon: {
                        url: iconUrl,
                        scaledSize: new google.maps.Size(25, 41),
                        anchor: new google.maps.Point(12, 41),
                    },
                    title: point.name,
                });

                const pointDataContent = `
                    <div style="max-width: 300px; max-height: 400px; overflow-y: auto; font-size: 12px; background: #fff; padding: 10px; border: 1px solid #ccc; border-radius: 4px;">
                        <h3 style="margin: 0 0 10px; font-size: 14px; color: #333;">${point.name}</h3>
                        <table style="width: 100%; border-collapse: collapse;">
                            ${Object.entries(point.properties)
                        .filter(([_, value]) => value !== null && value !== '')
                        .map(([key, value], index) => `
                                    <tr style="background-color: ${index % 2 === 0 ? '#f9f9f9' : '#fff'};">
                                        <td style="padding: 2px 5px; font-weight: bold; border-bottom: 1px solid #ddd; color: ${['type', 'olt_ip'].includes(key) ? '#d32f2f' : '#333'};">${key}</td>
                                        <td style="padding: 2px 5px; border-bottom: 1px solid #ddd;">${value}</td>
                                    </tr>
                                `)
                        .join('')}
                        </table>
                    </div>
                `;

                google.maps.event.addListener(marker, 'mouseover', () => {
                    const pointsDataBox = document.getElementById('points-data-box');
                    if (pointsDataBox) {
                        pointsDataBox.innerHTML = pointDataContent;
                    }
                });

                google.maps.event.addListener(marker, 'click', () => {
                    const pointsDataBox = document.getElementById('points-data-box');
                    if (pointsDataBox) {
                        pointsDataBox.innerHTML = pointDataContent;
                    }
                    markers.forEach(m => m._isSelected = false);
                    marker._isSelected = true;
                    const infoWindow = new google.maps.InfoWindow({ content: pointDataContent });
                    infoWindow.open(map, marker);
                });

                marker.pointName = point.name;
                markers.push(marker);
                blockCoords.push({ lat: point.coordinates[1], lng: point.coordinates[0] });
            } else {
                console.warn(`Skipping marker for ${point.name} - invalid coordinates:`, point.coordinates);
            }
        });

        if (blockCoords.length) {
            const bounds = new google.maps.LatLngBounds();
            blockCoords.forEach(coord => bounds.extend(coord));
            map.fitBounds(bounds);
            // Add padding by adjusting zoom
            google.maps.event.addListenerOnce(map, 'bounds_changed', () => {
                map.setZoom(map.getZoom() - 1);
            });
        }

        document.getElementById('result').innerHTML = `<p>${globalData.loop.length} points loaded.</p>`;
        document.getElementById('uploadConnectionsBtn').disabled = false;
        document.getElementById('downloadFormat').disabled = false;
        pointsUploaded = true;

        setupMarkerListeners();
    } catch (error) {
        console.error('Points upload error:', error);
        document.getElementById('result').innerHTML = `<p>Error uploading points: ${error.message}</p>`;
        document.getElementById('summary-content').innerHTML = 'Error loading points';
    } finally {
        pointsLoading.style.display = 'none';
        uploadPointsBtn.disabled = false;
    }
});

document.getElementById('uploadConnectionsBtn').addEventListener('click', async () => {
    if (!pointsUploaded) {
        document.getElementById('result').innerHTML = '<p>Please upload points first.</p>';
        return;
    }

    const connectionsFile = document.getElementById('connectionsFile').files[0];
    if (!connectionsFile) {
        document.getElementById('result').innerHTML = '<p>Please select a connections KML file.</p>';
        return;
    }

    const formData = new FormData();
    formData.append('connectionsFile', connectionsFile);

    const connectionsLoading = document.getElementById('connections-loading');
    const uploadConnectionsBtn = document.getElementById('uploadConnectionsBtn');
    connectionsLoading.style.display = 'block';
    uploadConnectionsBtn.disabled = true;

    try {
        console.log('Uploading connections...');
        const response = await fetch('/upload-connections', {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const data = await response.json();

        // Clear existing polylines and labels
        polylineHistory.forEach(history => {
            history.polyline.setMap(null);
            if (history.distanceLabel) history.distanceLabel.setMap(null);
        });
        polylineHistory.clear();

        const plottedSegments = new Set();
        const blockCoords = [];
        let totalLength = 0;

        data.connections.forEach(({ start, end, length, name, coordinates, color }) => {
            const segmentKey = `${start}-${end}`;
            if (plottedSegments.has(segmentKey)) {
                console.warn(`Duplicate skipped: ${segmentKey}`);
                return;
            }

            if (!Array.isArray(coordinates) || coordinates.length < 2) {
                console.warn(`Skipping ${segmentKey} - invalid coordinates:`, coordinates);
                return;
            }

            const coords = coordinates.map((coord, i) => {
                const [lng, lat] = Array.isArray(coord) ? coord : [null, null];
                if (typeof lng !== 'number' || typeof lat !== 'number' || isNaN(lng) || isNaN(lat)) {
                    console.warn(`Invalid coord at index ${i} in ${segmentKey}: [${lng}, ${lat}]`);
                    return null;
                }
                return { lat, lng };
            }).filter(coord => coord !== null);

            if (coords.length < 2) {
                console.warn(`Skipping ${segmentKey} - too few valid coords:`, coords);
                return;
            }

            const startPoint = globalData.loop.find(p => p.name === start);
            const endPoint = globalData.loop.find(p => p.name === end);

            if (!startPoint || !endPoint) {
                console.warn(`Skipping ${segmentKey} - points not found: start=${start}, end=${end}`);
                return;
            }

            endPoint.route = {
                features: [{
                    geometry: {
                        coordinates: coords.map(c => [c.lng, c.lat])
                    }
                }]
            };
            endPoint.connection = {
                length: length || 0,
                existing: true,
                color: color || '#55FF00'
            };

            const polyline = new google.maps.Polyline({
                path: coords,
                strokeColor: color || '#55FF00',
                strokeWeight: 4,
                strokeOpacity: 1,
                map,
                routeKey: segmentKey,
            });

            google.maps.event.addListener(polyline, 'click', () => {
                selectPolyline(polyline, segmentKey);
            });

            polylineHistory.set(segmentKey, {
                polyline,
                segmentData: { connection: { length: length || 0, existing: true } },
                distanceLabel: null
            });

            if (length) {
                const offsetIndex = Math.floor(coords.length * 0.25);
                const offsetPoint = coords[offsetIndex] || coords[Math.floor(coords.length / 2)];
                const distanceLabel = new google.maps.Marker({
                    position: offsetPoint,
                    map,
                    title: `${length.toFixed(2)} km`,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 0,
                    },
                     label: {
                        text:`${length.toFixed(2)} km`,
                        
                        className: 'distance-label',
                        color: '#fff',
                       
                    },
                });
                polylineHistory.get(segmentKey).distanceLabel = distanceLabel;
            }

            coords.forEach(coord => blockCoords.push(coord));
            totalLength += length || 0;
            plottedSegments.add(segmentKey);
        });

        globalData.existingLength = totalLength;
        globalData.complete = plottedSegments.size > 0;

        if (blockCoords.length) {
            const bounds = new google.maps.LatLngBounds();
            blockCoords.forEach(coord => bounds.extend(coord));
            map.fitBounds(bounds);
            google.maps.event.addListenerOnce(map, 'bounds_changed', () => {
                map.setZoom(map.getZoom() - 1);
            });
        }

        document.getElementById('summary-content').innerHTML = `
            <div><span class="line-indicator existing-line"></span>Existing Lines: ${totalLength.toFixed(2)} km</div>
            <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
        `;

        document.getElementById('downloadFormat').disabled = false;
    } catch (error) {
        console.error('Connections upload error:', error);
        document.getElementById('summary-content').innerHTML = 'Error loading connections';
    } finally {
        connectionsLoading.style.display = 'none';
        uploadConnectionsBtn.disabled = false;
    }
});

async function downloadFile(format) {
    if (!globalData || !map) {
        document.getElementById('result').innerHTML = `<p>Error: No map data to download</p>`;
        return;
    }

    const filteredGlobalData = {
        loop: globalData.loop.map(point => ({
            name: point.name,
            coordinates: point.coordinates,
            connection: point.connection,
            route: point.route
        })),
        mainPointName: globalData.mainPointName,
        totalLength: globalData.totalLength,
        connections: globalData.connections
    };

    const polylineHistoryObj = {};
    polylineHistory.forEach((value, key) => {
        const connection = value.segmentData?.connection || {};
        polylineHistoryObj[key] = {
            polyline: {
                coordinates: value.polyline.getPath().getArray().map(ll => ({
                    lat: parseFloat(ll.lat().toFixed(6)),
                    lng: parseFloat(ll.lng().toFixed(6))
                }))
            },
            segmentData: {
                connection: {
                    from: connection.from,
                    to: connection.to,
                    length: connection.length || 0,
                    existing: connection.existing || false
                }
            }
        };
    });

    const routeGroupsObj = {};
    routeGroups.forEach((value, key) => {
        routeGroupsObj[key] = {
            resultHtml: value.resultHtml
        };
    });

    const payload = JSON.stringify({ globalData: filteredGlobalData, polylineHistory: polylineHistoryObj, routeGroups: routeGroupsObj });
    const payloadSizeMB = new Blob([payload]).size / (1024 * 1024);
    console.log(`Payload size: ${payloadSizeMB.toFixed(2)} MB for /download/${format}`);
    if (payloadSizeMB > 50) {
        document.getElementById('result').innerHTML = `<p>Error: Data too large (${payloadSizeMB.toFixed(2)} MB). Try reducing the number of routes or points.</p>`;
        return;
    }

    try {
        const response = await fetch(`/download/${format}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
        });

        if (!response.ok) {
            const error = await response.json();
            document.getElementById('result').innerHTML = `<p>Error: ${error.error}</p>`;
            console.error('Download error:', error);
            return;
        }

        const blob = await response.blob();
        const contentDisposition = response.headers.get('Content-Disposition');
        const filename = contentDisposition?.match(/filename="(.+)"/)?.[1] || `routes.${format === 'shapefile' ? 'zip' : format}`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        document.getElementById('result').innerHTML = `<p>File downloaded as ${filename}</p>`;
    } catch (error) {
        document.getElementById('result').innerHTML = `<p>Error: Failed to download file - ${error.message}</p>`;
        console.error('Download error:', error);
    }
}

function selectPolyline(polyline, segmentKey) {
    if (selectedPolyline) {
        selectedPolyline.setOptions({ strokeWeight: 3, zIndex: 0 });
    }
    selectedPolyline = polyline;
    selectedSegmentKey = segmentKey;
    polyline.setOptions({ strokeWeight: 4, zIndex: 1 });
    console.log(`Selected polyline: ${segmentKey}`);
    const deleteBtn = document.getElementById('delete-route-btn');
    if (deleteBtn) {
        deleteBtn.disabled = false;
    }
    document.getElementById('result').innerHTML = `<p>Selected route: ${segmentKey.replace('-', ' to ')}</p>`;
}

function deletePolyline() {
    if (!confirm(`Delete route ${selectedSegmentKey.replace('-', ' to ')}?`)) return;

    if (!selectedPolyline || !selectedSegmentKey) {
        document.getElementById('result').innerHTML = `<p>No route selected to delete</p>`;
        return;
    }

    const history = polylineHistory.get(selectedSegmentKey);
    if (!history) {
        document.getElementById('result').innerHTML = `<p>Error: Route not found</p>`;
        return;
    }

    history.polyline.setMap(null);
    if (history.distanceLabel) history.distanceLabel.setMap(null);
    history.dragMarkers?.forEach(marker => marker.setMap(null));

    let fromName = '';
    let toName = '';
    for (const point of globalData.loop) {
        if (selectedSegmentKey.endsWith(`-${point.name}`)) {
            toName = point.name;
            fromName = selectedSegmentKey.slice(0, selectedSegmentKey.length - point.name.length - 1);
            break;
        }
    }

    if (!fromName || !toName) {
        document.getElementById('result').innerHTML = `<p>Error: Invalid segment key format</p>`;
        return;
    }

    const endPointIndex = globalData.loop.findIndex(p => p.name === toName);
    if (endPointIndex >= 0) {
        const point = globalData.loop[endPointIndex];
        if (point.connection) {
            if (history.segmentData.connection.existing) {
                globalData.existingLength -= point.connection.length || 0;
            }
            point.route = null;
            point.connection = null;
        }
    }

    polylineHistory.delete(selectedSegmentKey);

    proposedLengthGlobal = globalData.loop
        .filter(p => p.connection && !p.connection.existing)
        .reduce((sum, p) => sum + (p.connection?.length || 0), 0);

    const summaryElement = document.getElementById('summary-content');
    if (summaryElement) {
        summaryElement.innerHTML = `
            <div><span class="line-indicator existing-line"></span>Existing Lines: ${globalData.existingLength?.toFixed(2) || 0} km</div>
            <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
        `;
        summaryElement.style.display = 'none';
        summaryElement.offsetHeight;
        summaryElement.style.display = 'block';
    }

    document.getElementById('result').innerHTML = `<p>Route ${selectedSegmentKey.replace('-', ' to ')} deleted.</p>`;
    const deleteBtn = document.getElementById('delete-route-btn');
    if (deleteBtn) {
        deleteBtn.disabled = true;
    }

    selectedPolyline = null;
    selectedSegmentKey = null;
}

let startPoint = null, endPoint = null, startPointName = null, endPointName = null;
const routeBox = document.getElementById('route-box');
const startPointDisplay = document.getElementById('start-point');
const endPointDisplay = document.getElementById('end-point');
const calculateRouteBtn = document.getElementById('calculate-route-btn');
const routeLoading = document.getElementById('route-loading');

document.getElementById('show-route-btn').addEventListener('click', () => {
    if (markers.length === 0) {
        alert('Please upload points KML file to select routes.');
        return;
    }
    routeBox.style.display = 'block';
    startPoint = null;
    endPoint = null;
    startPointName = null;
    endPointName = null;
    startPointDisplay.textContent = 'Not selected';
    endPointDisplay.textContent = 'Not selected';
    calculateRouteBtn.disabled = true;
    setupMarkerListeners();
});

document.getElementById('close-box-btn').addEventListener('click', () => {
    routeBox.style.display = 'none';
    startPoint = null;
    endPoint = null;
    startPointName = null;
    endPointName = null;
    startPointDisplay.textContent = 'Not selected';
    endPointDisplay.textContent = 'Not selected';
    calculateRouteBtn.disabled = true;
    markers.forEach(marker => {
        marker.setTitle(marker.pointName);
    });
});

function clearAllRoutes() {
    routeGroups.forEach(group => {
        group.layers.forEach(layer => layer.setMap(null));
    });
    routeGroups.clear();
    proposedLengthGlobal = 0;
    globalData.loop.forEach(point => {
        if (point.connection && !point.connection.existing) {
            point.route = null;
            point.connection = null;
        }
    });
    polylineHistory.forEach((history, key) => {
        if (!history.segmentData.connection.existing) {
            polylineHistory.delete(key);
        }
    });
    document.getElementById('result').innerHTML = '';
    document.getElementById('start-point').innerHTML = '';
    document.getElementById('end-point').innerHTML = '';
    document.getElementById('summary-content').innerHTML = `
        <div><span class="line-indicator existing-line"></span>Existing Lines: ${globalData.existingLength?.toFixed(2) || 0} km</div>
        <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
    `;
    selectedPolyline = null;
    selectedSegmentKey = null;
    const deleteBtn = document.getElementById('delete-route-btn');
    if (deleteBtn) deleteBtn.disabled = true;
}

function setupMarkerListeners() {
    markers.forEach(marker => {
        google.maps.event.clearListeners(marker, 'click');
        google.maps.event.addListener(marker, 'click', () => {
            if (routeBox.style.display === 'block') {
                const latlng = marker.getPosition();
                if (!startPoint) {
                    startPoint = latlng;
                    startPointName = marker.pointName;
                    startPointDisplay.textContent = `${marker.pointName} (Lat: ${latlng.lat().toFixed(5)}, Lng: ${latlng.lng().toFixed(5)})`;
                } else if (!endPoint && (latlng.lat() !== startPoint.lat() || latlng.lng() !== startPoint.lng())) {
                    endPoint = latlng;
                    endPointName = marker.pointName;
                    endPointDisplay.textContent = `${marker.pointName} (Lat: ${latlng.lat().toFixed(5)}, Lng: ${latlng.lng().toFixed(5)})`;
                }
                if (startPoint && endPoint) {
                    calculateRouteBtn.disabled = false;
                }
            } else {
                const infoWindow = new google.maps.InfoWindow({
                    content: `<b>${marker.pointName}</b>`,
                });
                infoWindow.open(map, marker);
            }
        });
    });
}

function selectRoute(routeKey, selectedIndex) {
    const group = routeGroups.get(routeKey);
    const allPolylines = group.layers.filter(l => l instanceof google.maps.Polyline);
    const allMarkers = group.layers.filter(l => l instanceof google.maps.Marker && l.getTitle()?.includes(' km'));

    const selectedLayers = [];
    allPolylines.forEach((polyline, index) => {
        if (index === selectedIndex) {
            selectedLayers.push(polyline);
            const marker = allMarkers.find(m => m.routeIndex === index);
            if (marker) selectedLayers.push(marker);
        } else {
            polyline.setMap(null);
            const marker = allMarkers.find(m => m.routeIndex === index);
            if (marker) marker.setMap(null);
        }
    });

    routeGroups.set(routeKey, { layers: selectedLayers, resultHtml: group.resultHtml });

    for (let i = 1; i <= 3; i++) {
        const segmentKey = `${routeKey}-route${i}`;
        if (i - 1 !== selectedIndex) {
            polylineHistory.delete(segmentKey);
        }
    }

    const selectedPolyline = allPolylines[selectedIndex];
    const selectedMarker = allMarkers.find(m => m.routeIndex === selectedIndex);
    if (!selectedPolyline || !selectedMarker) {
        console.error('Error: Selected polyline or marker not found', { selectedIndex, routeKey });
        document.getElementById('result').innerHTML = `<p>Error: Route not found</p>`;
        return;
    }

    let fromName = '';
    let toName = '';
    for (const point of globalData.loop) {
        if (routeKey.endsWith(`-${point.name}`)) {
            toName = point.name;
            fromName = routeKey.slice(0, routeKey.length - point.name.length - 1);
            break;
        }
    }

    if (!fromName || !toName) {
        console.error(`Invalid route key format: ${routeKey}`);
        document.getElementById('result').innerHTML = `<p>Error: Invalid route key format</p>`;
        return;
    }

    const distanceMatch = selectedMarker.getTitle()?.match(/(\d+\.\d{2}) km/);
    const distance = distanceMatch ? parseFloat(distanceMatch[1]) : 0;

    let endPoint = globalData.loop.find(p => p.name === toName);
    if (!endPoint) {
        const routeCoords = selectedPolyline.getPath().getArray();
        const endCoord = routeCoords[routeCoords.length - 1];
        endPoint = globalData.loop.reduce((closest, p) => {
            if (!p.coordinates || p.coordinates.length < 2) return closest;
            const dist = Math.sqrt(
                Math.pow(p.coordinates[0] - endCoord.lng(), 2) +
                Math.pow(p.coordinates[1] - endCoord.lat(), 2)
            );
            return dist < closest.dist ? { point: p, dist } : closest;
        }, { point: null, dist: Infinity }).point;

        if (endPoint) {
            toName = endPoint.name;
        } else {
            console.error(`End point ${toName} not found`);
            document.getElementById('result').innerHTML = `<p>Error: End point ${toName} not found.</p>`;
            return;
        }
    }

    const selectedRoute = {
        name: endPoint.name,
        coordinates: endPoint.coordinates,
        route: {
            features: [{
                geometry: {
                    coordinates: selectedPolyline.getPath().getArray().map(latLng => [latLng.lng(), latLng.lat()])
                }
            }]
        },
        connection: {
            length: distance,
            existing: false,
            color: '#00FFFF'
        }
    };

    const existingIndex = globalData.loop.findIndex(p => p.name === toName);
    if (existingIndex >= 0) {
        globalData.loop[existingIndex] = { ...globalData.loop[existingIndex], route: selectedRoute.route, connection: selectedRoute.connection };
    } else {
        globalData.loop.push(selectedRoute);
    }

    proposedLengthGlobal = globalData.loop
        .filter(p => p.connection && !p.connection.existing)
        .reduce((sum, p) => sum + (p.connection?.length || 0), 0);

    const segmentKey = `${fromName}-${toName}`;
    selectedPolyline.routeKey = segmentKey;

    const routeCoords = selectedPolyline.getPath().getArray();
    if (!routeCoords || routeCoords.length < 4) {
        console.error('Error: Polyline has insufficient coordinates', { routeCoordsLength: routeCoords.length });
        document.getElementById('result').innerHTML = `<p>Error: Route has too few points to edit</p>`;
        return;
    }

    polylineHistory.set(segmentKey, {
        polyline: selectedPolyline,
        segmentData: { connection: { length: distance, existing: false, color: '#00FFFF' } },
        original: {
            coords: routeCoords.map(c => ({ lat: c.lat(), lng: c.lng() })),
            distance,
            markerPositions: [],
            labelPos: selectedMarker.getPosition() ? [selectedMarker.getPosition().lat(), selectedMarker.getPosition().lng()] : null,
            labelText: `${distance.toFixed(2)} km`
        },
        undoStack: [],
        dragMarkers: [],
        distanceLabel: selectedMarker
    });

    const history = polylineHistory.get(segmentKey);

    // Clear existing drag markers
    history.dragMarkers.forEach(marker => marker.setMap(null));
    history.dragMarkers = [];
    history.original.markerPositions = [];

    const fractions = [0.25, 0.5, 0.75];
    fractions.forEach((f, index) => {
        const pointIndex = Math.max(1, Math.min(routeCoords.length - 2, Math.floor(routeCoords.length * f)));
        const coord = routeCoords[pointIndex];
        if (!coord || isNaN(coord.lat()) || isNaN(coord.lng())) {
            console.warn(`Invalid coordinate at fraction ${f} (index ${pointIndex})`, { routeCoordsLength: routeCoords.length });
            document.getElementById('result').innerHTML += `<p>Warning: Invalid coordinate for drag marker ${index + 1}</p>`;
            return;
        }

        console.log(`Creating drag marker ${index + 1} at index ${pointIndex}`, { lat: coord.lat(), lng: coord.lng() });

        const dragMarker = new google.maps.Marker({
            position: { lat: coord.lat(), lng: coord.lng() },
            map: map,
            draggable: true,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: '#00FFFF',
                fillOpacity: 1,
                strokeColor: '#FFFFFF',
                strokeWeight: 2,
                scale: 5,
            },
            zIndex: 1000,
            title: `Drag Point ${index + 1}`,
        });

        if (!dragMarker) {
            console.error(`Failed to create drag marker ${index + 1}`);
            return;
        }

        selectedLayers.push(dragMarker);
        history.dragMarkers.push(dragMarker);
        history.original.markerPositions.push([coord.lat(), coord.lng()]);

        google.maps.event.addListener(dragMarker, 'dragend', async function (e) {
            if (!history) {
                console.error('History not found for segment', segmentKey);
                return;
            }

            // Save current state before updating
            const currentCoords = selectedPolyline.getPath().getArray().map(c => ({
                lat: c.lat(),
                lng: c.lng()
            }));
            const currentDistance = history.segmentData.connection?.length || 0;
            const markerPositions = history.dragMarkers.map(marker => {
                const latLng = marker.getPosition();
                return [latLng.lat(), latLng.lng()];
            });
            const labelPos = history.distanceLabel?.getPosition() ? [history.distanceLabel.getPosition().lat(), history.distanceLabel.getPosition().lng()] : null;

            // Validate data
            if (!Array.isArray(currentCoords) || currentCoords.length < 2 || currentCoords.some(c => typeof c.lat !== 'number' || typeof c.lng !== 'number')) {
                console.error('Invalid coordinates for undo state', currentCoords);
                document.getElementById('result').innerHTML = `<p>Error: Invalid coordinates saved</p>`;
                return;
            }

            console.log('Saving undo state:', { coords: currentCoords, distance: currentDistance, markerPositions, labelPos });

            history.undoStack.push({
                coords: currentCoords,
                distance: currentDistance,
                markerPositions,
                labelPos
            });

            lastMovedSegmentKey = segmentKey;
            console.log('Set lastMovedSegmentKey:', lastMovedSegmentKey);

            const undoBtn = document.getElementById('undo-move-btn');
            if (undoBtn) {
                undoBtn.disabled = false;
            }

            const newPos = e.latLng;
            const startPoint = routeCoords[0];
            const endPoint = routeCoords[routeCoords.length - 1];

            console.log('Drag end:', { newPos: { lat: newPos.lat(), lng: newPos.lng() }, startPoint, endPoint });

            directionsService.route(
                {
                    origin: startPoint,
                    destination: endPoint,
                    waypoints: [{ location: newPos, stopover: false }],
                    travelMode: google.maps.TravelMode.WALKING,
                    provideRouteAlternatives: false,
                },
                (result, status) => {
                    if (status === google.maps.DirectionsStatus.OK) {
                        const newCoords = result.routes[0].overview_path.map(p => ({ lat: p.lat(), lng: p.lng() }));
                        selectedPolyline.setPath(newCoords);
                        console.log('New route set', newCoords);

                        const updatedCoords = selectedPolyline.getPath().getArray();
                        const updatedFractions = [0.25, 0.5, 0.75];
                        history.dragMarkers.forEach((marker, index) => {
                            const newIndex = Math.max(1, Math.min(updatedCoords.length - 2, Math.floor(updatedCoords.length * updatedFractions[index])));
                            const newCoord = updatedCoords[newIndex];
                            if (newCoord) {
                                marker.setPosition(newCoord);
                                console.log(`Updated drag marker ${index + 1} to`, { lat: newCoord.lat(), lng: newCoord.lng() });
                            } else {
                                console.warn(`No valid coordinate for drag marker ${index + 1} at index ${newIndex}`);
                            }
                        });

                        const distanceKm = result.routes[0].legs.reduce((sum, leg) => sum + leg.distance.value, 0) / 1000;
                        if (history.distanceLabel) {
                            history.distanceLabel.setTitle(`${distanceKm.toFixed(2)} km`);
                            history.distanceLabel.setLabel({ text: `${distanceKm.toFixed(2)} km`, color: 'white', fontSize: '12px' });
                            const offsetIndex = Math.floor(updatedCoords.length * 0.25);
                            const offsetPoint = updatedCoords[offsetIndex] || updatedCoords[Math.floor(updatedCoords.length / 2)];
                            history.distanceLabel.setPosition(offsetPoint);
                            console.log('Distance label updated', { distance: distanceKm, position: offsetPoint });
                        }

                        if (history.segmentData.connection) {
                            proposedLengthGlobal -= history.segmentData.connection.length || 0;
                            proposedLengthGlobal += distanceKm;
                            history.segmentData.connection.length = distanceKm;
                        }

                        const endPointIndex = globalData.loop.findIndex(p => p.name === toName);
                        if (endPointIndex >= 0) {
                            globalData.loop[endPointIndex].connection = {
                                ...globalData.loop[endPointIndex].connection,
                                length: distanceKm
                            };
                            globalData.loop[endPointIndex].route = {
                                features: [{
                                    geometry: {
                                        coordinates: newCoords.map(c => [c.lng, c.lat])
                                    }
                                }]
                            };
                            console.log(`Updated globalData.loop for ${toName}`);
                        }

                        proposedLengthGlobal = globalData.loop
                            .filter(p => p.connection && !p.connection.existing)
                            .reduce((sum, p) => sum + (p.connection?.length || 0), 0);
                        console.log('Updated proposedLengthGlobal:', proposedLengthGlobal);

                        const summaryElement = document.getElementById('summary-content');
                        if (summaryElement) {
                            summaryElement.innerHTML = `
                                <div><span class="line-indicator existing-line"></span>Existing Lines: ${(globalData.existingLength?.toFixed(2) || 0)} km</div>
                                <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
                            `;
                            summaryElement.style.display = 'none';
                            summaryElement.offsetHeight;
                            summaryElement.style.display = 'block';
                            console.log('Summary updated after drag');
                        }
                    } else {
                        console.error('Directions API failed:', status);
                        document.getElementById('result').innerHTML = `<p>Error updating route: ${status}</p>`;
                        // Revert to previous state
                        if (history.undoStack.length > 0) {
                            const lastState = history.undoStack[history.undoStack.length - 1]; // Peek, don’t pop
                            history.polyline.setPath(lastState.coords);
                            history.dragMarkers.forEach((marker, index) => {
                                if (lastState.markerPositions[index]) {
                                    marker.setPosition({ lat: lastState.markerPositions[index][0], lng: lastState.markerPositions[index][1] });
                                }
                            });
                            if (history.distanceLabel && lastState.labelPos) {
                                history.distanceLabel.setPosition({ lat: lastState.labelPos[0], lng: lastState.labelPos[1] });
                                history.distanceLabel.setTitle(`${lastState.distance.toFixed(2)} km`);
                                history.distanceLabel.setLabel({ text: `${lastState.distance.toFixed(2)} km`, color: 'white', fontSize: '12px' });
                            }
                            console.log('Reverted to last state due to API failure');
                        }
                    }
                }
            );
        });
    });
    if (history.dragMarkers.length !== 3) {
        console.warn(`Expected 3 drag markers, but created ${history.dragMarkers.length}`);
        document.getElementById('result').innerHTML = `<p>Warning: Failed to create all drag markers (${history.dragMarkers.length}/3 created)</p>`;
    } else {
        console.log('Successfully created 3 drag markers');
        // Fit map to bounds to ensure markers are visible
        const bounds = new google.maps.LatLngBounds();
        routeCoords.forEach(coord => bounds.extend(coord));
        map.fitBounds(bounds);
    }

    google.maps.event.addListener(selectedPolyline, 'click', () => {
        selectPolyline(selectedPolyline, segmentKey);
    });

    document.getElementById('result').innerHTML = `<h4>Selected Route: ${fromName} to ${toName}</h4><p>Proposed Route (${distance.toFixed(2)} km)</p>`;
    const summaryElement = document.getElementById('summary-content');
    if (summaryElement) {
        summaryElement.innerHTML = `
            <div><span class="line-indicator existing-line"></span>Existing Lines: ${(globalData.existingLength?.toFixed(2) || 0)} km</div>
            <div><span class="line-indicator proposed-line"></span>Proposed Lines: ${proposedLengthGlobal.toFixed(2)} km</div>
        `;
        summaryElement.style.display = 'none';
        summaryElement.offsetHeight;
        summaryElement.style.display = 'block';
    }

    selectPolyline(selectedPolyline, segmentKey);
}

document.getElementById('calculate-route-btn').addEventListener('click', async () => {
    if (!startPoint || !endPoint || !startPointName || !endPointName) {
        return;
    }

    routeLoading.style.display = 'block';

    const fetchRoutes = () => {
        return new Promise((resolve, reject) => {
            directionsService.route(
                {
                    origin: startPoint,
                    destination: endPoint,
                    travelMode: google.maps.TravelMode.WALKING,
                    provideRouteAlternatives: true,
                },
                (result, status) => {
                    if (status === google.maps.DirectionsStatus.OK) {
                        const routes = result.routes.slice(0, 3).map((route, index) => ({
                            route: route.overview_path.map(p => ({ lat: p.lat(), lng: p.lng() })),
                            distance: route.legs.reduce((sum, leg) => sum + leg.distance.value, 0) / 1000,
                        }));
                        resolve(routes);
                    } else {
                        reject(new Error(`Directions API error: ${status}`));
                    }
                }
            );
        });
    };

    try {
        const routes = await fetchRoutes();
        const routeKey = `${startPointName}-${endPointName}`;

        if (routeGroups.has(routeKey)) {
            routeGroups.get(routeKey).layers.forEach(layer => layer.setMap(null));
            routeGroups.delete(routeKey);
        }

        const colors = ['#808080', '#007bff', '#28a745'];
        let resultHtml = `<h4>Select a route for ${startPointName} to ${endPointName}</h4><div id="route-selection-list">`;
        const routeLayers = [];

        routes.forEach((routeData, index) => {
            if (routeData.route && Array.isArray(routeData.route)) {
                const polyline = new google.maps.Polyline({
                    path: routeData.route,
                    strokeColor: colors[index],
                    strokeWeight: 3,
                    strokeOpacity: 0.8,
                    map,
                    routeIndex: index,
                    routeKey: routeKey
                });

                google.maps.event.addListener(polyline, 'click', function () {
                    selectRoute(this.routeKey, this.routeIndex);
                });

                routeLayers.push(polyline);

                const offsetIndex = Math.floor(routeData.route.length * 0.25);
                const offsetPoint = routeData.route[offsetIndex] || routeData.route[Math.floor(routeData.route.length / 2)];
                const distanceLabel = new google.maps.Marker({
                    position: offsetPoint,
                    map,
                    title: `${routeData.distance.toFixed(2)} km`,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 0,
                    },
                    label: {
                        text: `${routeData.distance.toFixed(2)} km`,
                        
                        className: 'distance-label',
                        color: '#fff',
                       
                    },
                    routeIndex: index
                });
                routeLayers.push(distanceLabel);

                const segmentKey = `${routeKey}-route${index + 1}`;
                polylineHistory.set(segmentKey, {
                    polyline,
                    segmentData: { connection: { length: routeData.distance, existing: false, color: colors[index] } },
                    distanceLabel
                });

                resultHtml += `<p><a href="#" data-route-index="${index}" style="color: ${colors[index]}; text-decoration: none;" onclick="selectRoute('${routeKey}', ${index}); return false;">Route ${index + 1} (${routeData.distance.toFixed(2)} km)</a></p>`;
            } else {
                resultHtml += `<p>Route ${index + 1}: Failed to load</p>`;
            }
        });

        resultHtml += `</div>`;
        routeGroups.set(routeKey, { layers: routeLayers, resultHtml });

        //document.getElementById('result').innerHTML = resultHtml;

        const allRouteCoords = routes.flatMap(r => r.route || []);
        if (allRouteCoords.length) {
            const bounds = new google.maps.LatLngBounds();
            allRouteCoords.forEach(coord => bounds.extend(coord));
            map.fitBounds(bounds);
            // google.maps.event.addListenerOnce(map, 'bounds_changed', () => {
            //     //map.setZoom(map.getZoom() - 1);
            // });
        }

        startPoint = null;
        endPoint = null;
        startPointName = null;
        endPointName = null;

        document.getElementById('start-point').textContent = 'Not selected';
        document.getElementById('end-point').textContent = 'Not selected';
        document.getElementById('calculate-route-btn').disabled = true;
    } catch (error) {
        document.getElementById('result').innerHTML = `<p>Error: ${error.message}</p>`;
    } finally {
        routeLoading.style.display = 'none';
    }
});

document.getElementById('delete-route-btn').addEventListener('click', () => {
    deletePolyline();
});

function generateKML() {
    if (!globalData || !map) {
        document.getElementById('result').innerHTML = `<p>Error: No map data to download</p>`;
        return;
    }

    const filteredGlobalData = {
        loop: globalData.loop.map(point => ({
            name: point.name,
            coordinates: point.coordinates,
            connection: point.connection,
            route: point.route
        })),
        mainPointName: globalData.mainPointName,
        totalLength: globalData.totalLength,
        connections: globalData.connections
    };

    const polylineHistoryObj = {};
    polylineHistory.forEach((value, key) => {
        const connection = value.segmentData?.connection || {};
        polylineHistoryObj[key] = {
            polyline: {
                coordinates: value.polyline.getPath().getArray().map(ll => ({
                    lat: parseFloat(ll.lat().toFixed(6)),
                    lng: parseFloat(ll.lng().toFixed(6))
                }))
            },
            segmentData: {
                connection: {
                    from: connection.from,
                    to: connection.to,
                    length: connection.length || 0,
                    existing: connection.existing || false
                }
            }
        };
    });

    const payload = JSON.stringify({ globalData: filteredGlobalData, polylineHistory: polylineHistoryObj });
    return payload;
}

async function saveKML() {
    const kmlContent = generateKML();

    try {
        const response = await fetch('/save-kml', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: kmlContent
        });

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const result = await response.json();
        document.getElementById('result').innerHTML = `<p>KML saved successfully</p>`;
    } catch (error) {
        console.error('Save KML error:', error);
        document.getElementById('result').innerHTML = `<p>Error saving KML: ${error.message}</p>`;
    }
}

document.getElementById('save-btn').addEventListener('click', saveKML);