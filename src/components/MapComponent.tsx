/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element */
"use client";

import { useEffect, useMemo, memo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
    iconUrl: markerIcon.src,
    iconRetinaUrl: markerIcon2x.src,
    shadowUrl: markerShadow.src,
});

interface PhotoMapProps {
    photos: any[];
    onMarkerClick?: (index: number) => void;
}

function MapUpdater({ center }: { center: [number, number] }) {
    const map = useMap();
    useEffect(() => {
        if (center[0] !== 0 || center[1] !== 0) {
            map.flyTo(center, map.getZoom() || 4);
        }
    }, [center, map]);
    return null;
}

const MapComponent = memo(function MapComponent({ photos, onMarkerClick }: PhotoMapProps) {
    const validEntries = useMemo(() => {
        return photos
            .map((photo, index) => ({ photo, index }))
            .filter(({ photo }) => typeof photo.lat === 'number' && typeof photo.lng === 'number' && Number.isFinite(photo.lat) && Number.isFinite(photo.lng));
    }, [photos]);

    const center: [number, number] = useMemo(() => {
        return validEntries.length > 0
            ? [validEntries[0].photo.lat, validEntries[0].photo.lng]
            : [20, 0];
    }, [validEntries]);

    return (
        <MapContainer
            center={center}
            zoom={3}
            className="flex-1 w-full min-h-[60vh] z-0"
            style={{ background: '#0a0a0a' }}
            scrollWheelZoom={true}
        >
            <TileLayer
                attribution='&copy; <a href="https://carto.com/">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
            {validEntries.length > 0 && <MapUpdater center={center} />}

            <MarkerClusterGroup
                chunkedLoading
                maxClusterRadius={50}
            >
                {validEntries.map(({ photo, index }) => (
                    <Marker
                        key={photo.id}
                        position={[photo.lat, photo.lng]}
                        eventHandlers={{
                            click: () => {
                                if (onMarkerClick) onMarkerClick(index);
                            }
                        }}
                    >
                        <Popup closeButton={false} className="custom-popup">
                            <div className="p-1 rounded bg-black cursor-pointer" onClick={() => onMarkerClick && onMarkerClick(index)}>
                                <img
                                    src={photo.thumbnailUrl}
                                    className="w-24 h-24 object-cover rounded shadow-md border border-white/10 hover:border-white/40 transition"
                                    alt="map thumbnail"
                                />
                            </div>
                        </Popup>
                    </Marker>
                ))}
            </MarkerClusterGroup>
        </MapContainer>
    );
});

export default MapComponent;
