'use client';

/**
 * ReportForm.tsx
 * Nigeria CEWS — Conflict Event Report Form
 * Next.js 14 · react-hook-form · Zod · MapLibre · Tailwind CSS
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, Controller, SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast, { Toaster } from 'react-hot-toast';
import { useDropzone } from 'react-dropzone';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { sealReport } from '@/lib/crypto';
import { storeOfflineReport } from '@/lib/offline-vault';

// ─── i18n labels ─────────────────────────────────────────────────────────────

type Locale = 'en' | 'ha' | 'yo' | 'ig' | 'pcm';

const LABELS: Record<Locale, Record<string, string>> = {
  en: {
    title: 'Submit Conflict Event Report',
    zone: 'Zone',
    state: 'State',
    lga: 'LGA',
    alert_type: 'Alert Type',
    description: 'Description',
    casualties_confirmed: 'Confirmed Casualties',
    casualties_estimated: 'Estimated Casualties',
    incident_occurred_at: 'Date & Time of Incident',
    location: 'Location',
    media: 'Upload Media',
    submit: 'Submit Report',
    offline: 'Offline — report will be queued',
    saving_offline: 'Saving offline…',
    submitting: 'Submitting…',
    success: 'Report submitted successfully',
    saved_offline: 'Report saved offline. Will sync when online.',
    gps_error: 'Could not get GPS location. Please pin on map.',
    drag_drop: 'Drag & drop files here, or click to select',
    max_size: 'Max 10 MB per file · Image, Audio, Video',
    lang: 'Language',
  },
  ha: {
    title: 'Aika Rahoton Rikici',
    zone: 'Yanki',
    state: 'Jiha',
    lga: 'LGA',
    alert_type: 'Nau\'in Faɗakarwa',
    description: 'Bayani',
    casualties_confirmed: 'Adadin Wadanda Suka Tabbata',
    casualties_estimated: 'Adadin Da Ake Tsammani',
    incident_occurred_at: 'Ranar da Lokacin Taron',
    location: 'Wuri',
    media: 'Loda Fayiloli',
    submit: 'Aika Rahoto',
    offline: 'Babu Intanet — za a adana rahoto',
    saving_offline: 'Ana adanawa…',
    submitting: 'Ana aika…',
    success: 'An aika rahoto cikin nasara',
    saved_offline: 'Rahoto an adana. Za a aika yayin haɗin Intanet.',
    gps_error: 'Ba a iya samun GPS. Don Allah saka alama akan taswirar.',
    drag_drop: 'Ja fayiloli nan, ko danna zaɓa',
    max_size: 'Max 10 MB · Hoto, Sauti, Bidiyo',
    lang: 'Harshe',
  },
  yo: {
    title: 'Firanṣẹ Ijabọ Ija',
    zone: 'Agbegbe',
    state: 'Ipinlẹ',
    lga: 'LGA',
    alert_type: 'Iru Ikilọ',
    description: 'Apejuwe',
    casualties_confirmed: 'Iye Olufaragba Ti O Jẹri',
    casualties_estimated: 'Iye Olufaragba Ti A Foju Iṣiro',
    incident_occurred_at: 'Ọjọ ati Akoko Iṣẹlẹ',
    location: 'Ibi',
    media: 'Gbe Faili Soke',
    submit: 'Fi Ijabọ Ranṣẹ',
    offline: 'Ko si nẹtiwọki — yoo fi pamọ',
    saving_offline: 'Fipamọ…',
    submitting: 'Fifiranṣẹ…',
    success: 'A fi ijabọ ranṣẹ ni aṣeyọri',
    saved_offline: 'Ijabọ ti fipamọ. Yoo synchronize nigbati o ba wa lori ayelujara.',
    gps_error: 'Ko le gba GPS. Jọwọ fi aami sori maapu.',
    drag_drop: 'Fa faili nibi tabi tẹ lati yan',
    max_size: 'Max 10 MB · Aworan, Ohun, Fidio',
    lang: 'Ede',
  },
  ig: {
    title: 'Tinye Akụkọ Esemokwu',
    zone: 'Mpaghara',
    state: 'Steeti',
    lga: 'LGA',
    alert_type: 'Ụdị Ọchịchọ',
    description: 'Nkọwa',
    casualties_confirmed: 'Ndị Merụrụ Ahụ Nke A Gosi',
    casualties_estimated: 'Ndị Merụrụ Ahụ Nke Atụrụ Anya',
    incident_occurred_at: 'Ụbọchị na Oge Mmekọrịta',
    location: 'Ebe',
    media: 'Bulite Faịlụ',
    submit: 'Tinye Akụkọ',
    offline: 'Enweghị intaneti — a ga-echekwa',
    saving_offline: 'Na-echekwa…',
    submitting: 'Na-edozi…',
    success: 'A tinye akụkọ n\'ụzọ ọma',
    saved_offline: 'Achekwara akụkọ. Ọ ga-ezigara mgbe ịnweghachi intaneti.',
    gps_error: 'Enweghị ike nweta GPS. Biko kọọ n\'map.',
    drag_drop: 'Kụzuo faịlụ ebe a ma ọ bụ pịa ịhọrọ',
    max_size: 'Max 10 MB · Ihe onyonyo, Ụda, Vidiyo',
    lang: 'Asụsụ',
  },
  pcm: {
    title: 'Submit Conflict Report',
    zone: 'Zone',
    state: 'State',
    lga: 'LGA',
    alert_type: 'Alert Type',
    description: 'Wetin Happen',
    casualties_confirmed: 'Confirmed Casualties',
    casualties_estimated: 'Estimated Casualties',
    incident_occurred_at: 'When E Happen',
    location: 'Where E Happen',
    media: 'Upload File',
    submit: 'Submit Report',
    offline: 'No network — dem go save am',
    saving_offline: 'Dey save…',
    submitting: 'Dey send…',
    success: 'Report don submit well well',
    saved_offline: 'Report don save. Go sync when network come back.',
    gps_error: 'No fit get GPS. Pin the place for map abeg.',
    drag_drop: 'Drag file come here or click pick',
    max_size: 'Max 10 MB · Pic, Audio, Video',
    lang: 'Language',
  },
};

// ─── Geography data ───────────────────────────────────────────────────────────

export const ZONES = ['NWZ', 'NEZ', 'NCZ', 'SWZ', 'SEZ', 'SSZ'] as const;
export type Zone = (typeof ZONES)[number];

const ZONE_LABELS: Record<Zone, string> = {
  NWZ: 'North West',
  NEZ: 'North East',
  NCZ: 'North Central',
  SWZ: 'South West',
  SEZ: 'South East',
  SSZ: 'South South',
};

const STATES_BY_ZONE: Record<Zone, string[]> = {
  NWZ: ['Kano', 'Kaduna', 'Katsina', 'Zamfara', 'Kebbi', 'Sokoto', 'Jigawa'],
  NEZ: ['Borno', 'Yobe', 'Adamawa', 'Gombe', 'Bauchi', 'Taraba'],
  NCZ: ['FCT', 'Niger', 'Kwara', 'Kogi', 'Benue', 'Plateau', 'Nasarawa'],
  SWZ: ['Lagos', 'Ogun', 'Oyo', 'Osun', 'Ondo', 'Ekiti'],
  SEZ: ['Enugu', 'Anambra', 'Imo', 'Abia', 'Ebonyi'],
  SSZ: ['Rivers', 'Delta', 'Bayelsa', 'Edo', 'Akwa Ibom', 'Cross River'],
};

// Abbreviated LGA list per state (representative sample — extend as needed)
const LGAS_BY_STATE: Record<string, string[]> = {
  Kano: ['Kano Municipal', 'Fagge', 'Dala', 'Gwale', 'Tarauni', 'Nassarawa', 'Kumbotso'],
  Kaduna: ['Kaduna North', 'Kaduna South', 'Zaria', 'Soba', 'Giwa', 'Birnin Gwari', 'Kauru'],
  Katsina: ['Katsina', 'Daura', 'Funtua', 'Dutsin-Ma', 'Malumfashi', 'Jibia'],
  Zamfara: ['Gusau', 'Anka', 'Kaura Namoda', 'Shinkafi', 'Maru', 'Zurmi'],
  Kebbi: ['Birnin Kebbi', 'Argungu', 'Koko-Besse', 'Gwandu', 'Yauri'],
  Sokoto: ['Sokoto North', 'Sokoto South', 'Dange-Shuni', 'Gada', 'Illela'],
  Jigawa: ['Dutse', 'Hadejia', 'Kazaure', 'Ringim', 'Gumel'],
  Borno: ['Maiduguri', 'Konduga', 'Gwoza', 'Chibok', 'Bama', 'Dikwa'],
  Yobe: ['Damaturu', 'Potiskum', 'Nguru', 'Geidam', 'Bade'],
  Adamawa: ['Yola North', 'Yola South', 'Mubi North', 'Mubi South', 'Michika'],
  Gombe: ['Gombe', 'Balanga', 'Funakaye', 'Kwami', 'Yamaltu-Deba'],
  Bauchi: ['Bauchi', 'Dass', 'Tafawa Balewa', 'Ningi', 'Katagum'],
  Taraba: ['Jalingo', 'Wukari', 'Bali', 'Gassol', 'Sardauna'],
  FCT: ['Abuja Municipal', 'Gwagwalada', 'Kuje', 'Bwari', 'Kwali', 'Abaji'],
  Niger: ['Minna', 'Suleja', 'Bida', 'Kontagora', 'Lapai', 'Agaie'],
  Kwara: ['Ilorin East', 'Ilorin West', 'Offa', 'Ekiti-Kwara', 'Oke-Ero'],
  Kogi: ['Lokoja', 'Okene', 'Kabba-Bunu', 'Igalamela-Odolu', 'Ofu'],
  Benue: ['Makurdi', 'Gboko', 'Katsina-Ala', 'Vandeikya', 'Otukpo'],
  Plateau: ['Jos North', 'Jos South', 'Barkin Ladi', 'Bokkos', 'Shendam'],
  Nasarawa: ['Lafia', 'Keffi', 'Akwanga', 'Obi', 'Doma'],
  Lagos: ['Lagos Island', 'Lagos Mainland', 'Surulere', 'Ikeja', 'Alimosho', 'Eti-Osa'],
  Ogun: ['Abeokuta North', 'Abeokuta South', 'Ijebu Ode', 'Sagamu', 'Ota'],
  Oyo: ['Ibadan North', 'Ibadan South-West', 'Ogbomosho North', 'Oyo East', 'Saki East'],
  Osun: ['Osogbo', 'Ife Central', 'Iwo', 'Ede North', 'Boripe'],
  Ondo: ['Akure South', 'Akure North', 'Owo', 'Ondo East', 'Okitipupa'],
  Ekiti: ['Ado-Ekiti', 'Efon', 'Ikere', 'Oye', 'Ijero'],
  Enugu: ['Enugu East', 'Enugu North', 'Enugu South', 'Nkanu East', 'Igbo-Eze North'],
  Anambra: ['Awka North', 'Awka South', 'Onitsha North', 'Onitsha South', 'Nnewi North'],
  Imo: ['Owerri Municipal', 'Owerri North', 'Owerri West', 'Orlu', 'Okigwe'],
  Abia: ['Umuahia North', 'Umuahia South', 'Aba North', 'Aba South', 'Ohafia'],
  Ebonyi: ['Abakaliki', 'Afikpo North', 'Afikpo South', 'Ikwo', 'Izzi'],
  Rivers: ['Port Harcourt', 'Obio-Akpor', 'Eleme', 'Ikwerre', 'Tai', 'Gokana'],
  Delta: ['Warri North', 'Warri South', 'Uvwie', 'Oshimili North', 'Oshimili South'],
  Bayelsa: ['Yenagoa', 'Ogbia', 'Brass', 'Kolokuma-Opokuma', 'Sagbama'],
  Edo: ['Oredo', 'Ikpoba-Okha', 'Egor', 'Ovia North-East', 'Orhionmwon'],
  'Akwa Ibom': ['Uyo', 'Ikot Ekpene', 'Eket', 'Abak', 'Etinan'],
  'Cross River': ['Calabar Municipal', 'Calabar South', 'Abi', 'Boki', 'Obudu'],
};

// ─── Alert type options ───────────────────────────────────────────────────────

const ALERT_TYPES = [
  { value: 'armed_conflict', label: 'Armed Conflict' },
  { value: 'communal_violence', label: 'Communal Violence' },
  { value: 'kidnapping', label: 'Kidnapping / Abduction' },
  { value: 'mass_atrocity', label: 'Mass Atrocity' },
  { value: 'banditry', label: 'Banditry / Robbery' },
  { value: 'terrorism', label: 'Terrorism' },
  { value: 'protest', label: 'Protest / Civil Unrest' },
  { value: 'other', label: 'Other' },
] as const;

// ─── Zone-specific indicator fields ──────────────────────────────────────────

const ZONE_INDICATORS: Record<Zone, { label: string; name: string }[]> = {
  NWZ: [
    { label: 'Bandit group involved', name: 'nwz_bandit_group' },
    { label: 'Rustling incident', name: 'nwz_rustling' },
    { label: 'Forest camp proximity', name: 'nwz_forest_camp' },
  ],
  NEZ: [
    { label: 'Boko Haram / ISWAP linked', name: 'nez_iswap' },
    { label: 'IDP camp impacted', name: 'nez_idp_camp' },
    { label: 'Aid worker threatened', name: 'nez_aid_worker' },
  ],
  NCZ: [
    { label: 'Farmer-herder clash', name: 'ncz_farmer_herder' },
    { label: 'Tiv/Fulani dimension', name: 'ncz_ethnic' },
    { label: 'River basin conflict', name: 'ncz_river' },
  ],
  SWZ: [
    { label: 'Amotekun involvement', name: 'swz_amotekun' },
    { label: 'Kidnap-for-ransom', name: 'swz_kidnap_ransom' },
    { label: 'Road ambush', name: 'swz_road_ambush' },
  ],
  SEZ: [
    { label: 'ESN / IPOB dimension', name: 'sez_ipob' },
    { label: 'Attack on security personnel', name: 'sez_security_attack' },
    { label: 'Monday sit-at-home enforced', name: 'sez_sitathoeme' },
  ],
  SSZ: [
    { label: 'Militant group activity', name: 'ssz_militant' },
    { label: 'Pipeline vandalism', name: 'ssz_pipeline' },
    { label: 'Kidnap / oil bunkering', name: 'ssz_bunkering' },
  ],
};

// ─── Zod schema ───────────────────────────────────────────────────────────────

const reportSchema = z.object({
  zone: z.enum(ZONES, { required_error: 'Zone is required' }),
  state: z.string().min(1, 'State is required'),
  lga: z.string().min(1, 'LGA is required'),
  alert_type: z.enum(
    ['armed_conflict', 'communal_violence', 'kidnapping', 'mass_atrocity', 'banditry', 'terrorism', 'protest', 'other'],
    { required_error: 'Alert type is required' }
  ),
  description: z.string().min(20, 'Description must be at least 20 characters'),
  casualties_confirmed: z.coerce.number().int().min(0).optional(),
  casualties_estimated: z.coerce.number().int().min(0).optional(),
  incident_occurred_at: z.string().min(1, 'Incident date/time is required'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  // Zone-specific boolean indicators (optional)
  nwz_bandit_group: z.boolean().optional(),
  nwz_rustling: z.boolean().optional(),
  nwz_forest_camp: z.boolean().optional(),
  nez_iswap: z.boolean().optional(),
  nez_idp_camp: z.boolean().optional(),
  nez_aid_worker: z.boolean().optional(),
  ncz_farmer_herder: z.boolean().optional(),
  ncz_ethnic: z.boolean().optional(),
  ncz_river: z.boolean().optional(),
  swz_amotekun: z.boolean().optional(),
  swz_kidnap_ransom: z.boolean().optional(),
  swz_road_ambush: z.boolean().optional(),
  sez_ipob: z.boolean().optional(),
  sez_security_attack: z.boolean().optional(),
  sez_sitathoeme: z.boolean().optional(),
  ssz_militant: z.boolean().optional(),
  ssz_pipeline: z.boolean().optional(),
  ssz_bunkering: z.boolean().optional(),
});

type ReportFormValues = z.infer<typeof reportSchema>;

// ─── Media file type ─────────────────────────────────────────────────────────

interface MediaFile {
  file: File;
  preview: string;
  type: 'image' | 'audio' | 'video';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SERVER_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_SERVER_ECDH_KEY ?? '';

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface FieldLabelProps {
  htmlFor: string;
  children: React.ReactNode;
  required?: boolean;
}
function FieldLabel({ htmlFor, children, required }: FieldLabelProps) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-200 mb-1">
      {children}
      {required && <span className="text-red-400 ml-1" aria-hidden>*</span>}
    </label>
  );
}

interface FieldErrorProps {
  message?: string;
}
function FieldError({ message }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-red-400">
      {message}
    </p>
  );
}

// ─── Map pin picker ───────────────────────────────────────────────────────────

interface MapPinPickerProps {
  lat?: number;
  lng?: number;
  onChange: (lat: number, lng: number) => void;
}

function MapPinPicker({ lat, lng, onChange }: MapPinPickerProps) {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [
          {
            id: 'osm-tiles-layer',
            type: 'raster',
            source: 'osm-tiles',
          },
        ],
      },
      center: [lng ?? 8.6753, lat ?? 9.082],
      zoom: lat ? 10 : 5,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      if (lat !== undefined && lng !== undefined) {
        const marker = new maplibregl.Marker({ color: '#ef4444', draggable: true })
          .setLngLat([lng, lat])
          .addTo(map);
        marker.on('dragend', () => {
          const { lng: mLng, lat: mLat } = marker.getLngLat();
          onChange(mLat, mLng);
        });
        markerRef.current = marker;
      }
    });

    map.on('click', (e) => {
      const { lng: clickLng, lat: clickLat } = e.lngLat;
      if (markerRef.current) {
        markerRef.current.setLngLat([clickLng, clickLat]);
      } else {
        const marker = new maplibregl.Marker({ color: '#ef4444', draggable: true })
          .setLngLat([clickLng, clickLat])
          .addTo(map);
        marker.on('dragend', () => {
          const { lng: mLng, lat: mLat } = marker.getLngLat();
          onChange(mLat, mLng);
        });
        markerRef.current = marker;
      }
      onChange(clickLat, clickLng);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-48 rounded-lg border border-gray-600 overflow-hidden"
      aria-label="Map — click to pin incident location"
      role="application"
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReportForm() {
  const [locale, setLocale] = useState<Locale>('en');
  const t = LABELS[locale];
  const [isOnline, setIsOnline] = useState(true);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ReportFormValues>({
    resolver: zodResolver(reportSchema),
    defaultValues: {
      casualties_confirmed: undefined,
      casualties_estimated: undefined,
    },
  });

  const selectedZone = watch('zone');
  const selectedState = watch('state');

  // ── Online / offline listener ────────────────────────────────────────────
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // ── GPS on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setValue('latitude', pos.coords.latitude);
        setValue('longitude', pos.coords.longitude);
      },
      () => toast.error(t.gps_error),
      { timeout: 8000, enableHighAccuracy: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Dropzone ─────────────────────────────────────────────────────────────
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'image/*': [], 'audio/*': [], 'video/*': [] },
    maxSize: 10 * 1024 * 1024, // 10 MB
    onDropAccepted: useCallback((accepted: File[]) => {
      const mapped: MediaFile[] = accepted.map((f) => ({
        file: f,
        preview: URL.createObjectURL(f),
        type: f.type.startsWith('image/')
          ? 'image'
          : f.type.startsWith('audio/')
          ? 'audio'
          : 'video',
      }));
      setMediaFiles((prev) => [...prev, ...mapped]);
    }, []),
    onDropRejected: () => toast.error('File rejected — check type and size (max 10 MB).'),
  });

  // ── Cleanup object URLs ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      mediaFiles.forEach((m) => URL.revokeObjectURL(m.preview));
    };
  }, [mediaFiles]);

  // ── Map pin callback ─────────────────────────────────────────────────────
  const handleMapPin = useCallback(
    (lat: number, lng: number) => {
      setValue('latitude', lat);
      setValue('longitude', lng);
    },
    [setValue]
  );

  // ── Submit handler ───────────────────────────────────────────────────────
  const onSubmit: SubmitHandler<ReportFormValues> = async (data) => {
    setIsSubmitting(true);
    const toastId = toast.loading(isOnline ? t.submitting : t.saving_offline);

    try {
      // Serialise media to base64 data-URLs (offline safe)
      const mediaRefs = await Promise.all(mediaFiles.map((m) => fileToBase64(m.file)));

      if (!isOnline || !SERVER_PUBLIC_KEY) {
        // Store offline
        await storeOfflineReport({
          id: crypto.randomUUID(),
          zone: data.zone,
          state: data.state,
          lga: data.lga,
          alert_type: data.alert_type as any,
          incident_occurred_at: data.incident_occurred_at,
          encrypted_payload: JSON.stringify(data), // stored unencrypted locally (vault only)
          media_refs: mediaRefs,
          ephemeral_public_key: '',
          checksum: '',
        });
        toast.success(t.saved_offline, { id: toastId });
        return;
      }

      // Encrypt
      const { ciphertext, ephemeralPublicKey, checksum } = await sealReport(data, SERVER_PUBLIC_KEY);

      const formData = new FormData();
      formData.append('zone', data.zone);
      formData.append('state', data.state);
      formData.append('lga', data.lga);
      formData.append('encrypted_payload', ciphertext);
      formData.append('ephemeral_public_key', ephemeralPublicKey);
      formData.append('checksum', checksum);
      mediaFiles.forEach((m, i) => formData.append(`media_${i}`, m.file));

      const res = await fetch('/api/v1/ingest/report', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      toast.success(t.success, { id: toastId });
    } catch (err) {
      console.error('[ReportForm] Submit error', err);
      // Fall back to offline vault on network failure
      try {
        await storeOfflineReport({
          id: crypto.randomUUID(),
          zone: data.zone,
          state: data.state,
          lga: data.lga,
          alert_type: data.alert_type as any,
          incident_occurred_at: data.incident_occurred_at,
          encrypted_payload: JSON.stringify(data),
          media_refs: [],
          ephemeral_public_key: '',
          checksum: '',
        });
        toast.success(t.saved_offline, { id: toastId });
      } catch {
        toast.error('Failed to save report. Please try again.', { id: toastId });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const latVal = watch('latitude');
  const lngVal = watch('longitude');

  const statesForZone = selectedZone ? STATES_BY_ZONE[selectedZone] : [];
  const lgasForState = selectedState ? (LGAS_BY_STATE[selectedState] ?? []) : [];
  const zoneIndicators = selectedZone ? ZONE_INDICATORS[selectedZone] : [];

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-900 text-white py-8 px-4">
      <Toaster position="top-right" toastOptions={{ className: 'bg-gray-800 text-white' }} />

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">{t.title}</h1>
          <div className="flex items-center gap-3">
            {/* Offline badge */}
            {!isOnline && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-900 px-3 py-1 text-xs font-medium text-amber-300 border border-amber-700"
                role="status"
                aria-live="polite"
              >
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" aria-hidden />
                {t.offline}
              </span>
            )}

            {/* Language selector */}
            <div>
              <label htmlFor="locale-select" className="sr-only">{t.lang}</label>
              <select
                id="locale-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label={t.lang}
              >
                <option value="en">English</option>
                <option value="ha">Hausa</option>
                <option value="yo">Yoruba</option>
                <option value="ig">Igbo</option>
                <option value="pcm">Pidgin</option>
              </select>
            </div>
          </div>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          aria-label={t.title}
          className="space-y-6"
        >
          {/* Zone */}
          <div>
            <FieldLabel htmlFor="zone" required>{t.zone}</FieldLabel>
            <Controller
              control={control}
              name="zone"
              render={({ field }) => (
                <select
                  {...field}
                  id="zone"
                  aria-required="true"
                  aria-describedby={errors.zone ? 'zone-error' : undefined}
                  className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onChange={(e) => {
                    field.onChange(e);
                    setValue('state', '');
                    setValue('lga', '');
                  }}
                >
                  <option value="">-- Select Zone --</option>
                  {ZONES.map((z) => (
                    <option key={z} value={z}>{z} — {ZONE_LABELS[z]}</option>
                  ))}
                </select>
              )}
            />
            <FieldError message={errors.zone?.message} />
          </div>

          {/* State */}
          <div>
            <FieldLabel htmlFor="state" required>{t.state}</FieldLabel>
            <select
              id="state"
              {...register('state', {
                onChange: () => setValue('lga', ''),
              })}
              aria-required="true"
              disabled={!selectedZone}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="">-- Select State --</option>
              {statesForZone.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <FieldError message={errors.state?.message} />
          </div>

          {/* LGA */}
          <div>
            <FieldLabel htmlFor="lga" required>{t.lga}</FieldLabel>
            <select
              id="lga"
              {...register('lga')}
              aria-required="true"
              disabled={!selectedState}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="">-- Select LGA --</option>
              {lgasForState.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <FieldError message={errors.lga?.message} />
          </div>

          {/* Alert Type */}
          <div>
            <FieldLabel htmlFor="alert_type" required>{t.alert_type}</FieldLabel>
            <select
              id="alert_type"
              {...register('alert_type')}
              aria-required="true"
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- Select Type --</option>
              {ALERT_TYPES.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
            <FieldError message={errors.alert_type?.message} />
          </div>

          {/* Description */}
          <div>
            <FieldLabel htmlFor="description" required>{t.description}</FieldLabel>
            <textarea
              id="description"
              rows={4}
              {...register('description')}
              aria-required="true"
              aria-describedby={errors.description ? 'desc-error' : 'desc-hint'}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              placeholder="Describe the incident in detail…"
            />
            <p id="desc-hint" className="mt-1 text-xs text-gray-400">Minimum 20 characters.</p>
            <FieldError message={errors.description?.message} />
          </div>

          {/* Casualties */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="casualties_confirmed">{t.casualties_confirmed}</FieldLabel>
              <input
                id="casualties_confirmed"
                type="number"
                min={0}
                {...register('casualties_confirmed')}
                className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0"
              />
              <FieldError message={errors.casualties_confirmed?.message} />
            </div>
            <div>
              <FieldLabel htmlFor="casualties_estimated">{t.casualties_estimated}</FieldLabel>
              <input
                id="casualties_estimated"
                type="number"
                min={0}
                {...register('casualties_estimated')}
                className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0"
              />
              <FieldError message={errors.casualties_estimated?.message} />
            </div>
          </div>

          {/* Incident Date/Time */}
          <div>
            <FieldLabel htmlFor="incident_occurred_at" required>{t.incident_occurred_at}</FieldLabel>
            <input
              id="incident_occurred_at"
              type="datetime-local"
              {...register('incident_occurred_at')}
              aria-required="true"
              max={new Date().toISOString().slice(0, 16)}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <FieldError message={errors.incident_occurred_at?.message} />
          </div>

          {/* Location */}
          <fieldset className="rounded-lg border border-gray-700 p-4">
            <legend className="text-sm font-medium text-gray-200 px-1">{t.location}</legend>
            <p className="text-xs text-gray-400 mb-3">
              GPS auto-detected: {latVal !== undefined ? `${latVal.toFixed(5)}, ${lngVal?.toFixed(5)}` : 'Unavailable — click map to pin.'}
            </p>
            <MapPinPicker lat={latVal} lng={lngVal} onChange={handleMapPin} />
            {latVal !== undefined && (
              <p className="mt-2 text-xs text-green-400" aria-live="polite">
                ✓ Pinned at {latVal.toFixed(5)}, {lngVal?.toFixed(5)}
              </p>
            )}
          </fieldset>

          {/* Zone-specific indicators */}
          {zoneIndicators.length > 0 && (
            <fieldset className="rounded-lg border border-blue-700 bg-blue-950/30 p-4">
              <legend className="text-sm font-semibold text-blue-300 px-1">
                {ZONE_LABELS[selectedZone]} — Specific Indicators
              </legend>
              <div className="mt-2 space-y-2">
                {zoneIndicators.map((ind) => (
                  <label key={ind.name} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      {...register(ind.name as keyof ReportFormValues)}
                      className="h-4 w-4 rounded border-gray-500 bg-gray-700 text-blue-500 focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-300">{ind.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {/* Media upload */}
          <div>
            <FieldLabel htmlFor="media-dropzone">{t.media}</FieldLabel>
            <div
              {...getRootProps({
                id: 'media-dropzone',
                role: 'button',
                'aria-label': t.drag_drop,
                tabIndex: 0,
                onKeyDown: (e) => {
                  if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click();
                },
              })}
              className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
                isDragActive
                  ? 'border-blue-400 bg-blue-950/40'
                  : 'border-gray-600 hover:border-gray-400'
              }`}
            >
              <input {...getInputProps()} />
              <p className="text-sm text-gray-400">{t.drag_drop}</p>
              <p className="text-xs text-gray-500 mt-1">{t.max_size}</p>
            </div>

            {mediaFiles.length > 0 && (
              <ul className="mt-3 space-y-2" aria-label="Attached files">
                {mediaFiles.map((m, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded-md bg-gray-800 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {m.type === 'image' && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.preview} alt="" className="h-8 w-8 object-cover rounded" />
                      )}
                      {m.type === 'audio' && <span aria-hidden>🎵</span>}
                      {m.type === 'video' && <span aria-hidden>🎬</span>}
                      <span className="text-xs text-gray-300 truncate">{m.file.name}</span>
                      <span className="text-xs text-gray-500 shrink-0">
                        ({(m.file.size / 1024 / 1024).toFixed(2)} MB)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setMediaFiles((prev) => prev.filter((_, idx) => idx !== i))
                      }
                      aria-label={`Remove ${m.file.name}`}
                      className="ml-2 text-gray-400 hover:text-red-400 shrink-0"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-3 text-sm font-semibold text-white transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-gray-900"
          >
            {isSubmitting ? (isOnline ? t.submitting : t.saving_offline) : t.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
