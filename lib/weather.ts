// Open-Meteo. No API key, two hops: name -> lat/lon, then lat/lon -> current conditions.

export type Weather = {
  location: string;
  temperatureC: number;
  feelsLikeC: number;
  humidityPct: number;
  windKph: number;
  description: string;
};

// WMO weather interpretation codes, condensed to the ones Open-Meteo actually returns.
const WMO_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snowfall",
  73: "moderate snowfall",
  75: "heavy snowfall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

export async function getWeather(location: string): Promise<Weather> {
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", location);
  geoUrl.searchParams.set("count", "1");
  geoUrl.searchParams.set("language", "en");
  geoUrl.searchParams.set("format", "json");

  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) throw new Error(`Geocoding failed: ${geoRes.status}`);
  const geo = await geoRes.json();

  const place = geo.results?.[0];
  if (!place) throw new Error(`No place found matching "${location}"`);

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
  );

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast failed: ${res.status}`);
  const data = await res.json();
  const now = data.current;

  return {
    location: [place.name, place.country].filter(Boolean).join(", "),
    temperatureC: now.temperature_2m,
    feelsLikeC: now.apparent_temperature,
    humidityPct: now.relative_humidity_2m,
    windKph: now.wind_speed_10m,
    description: WMO_CODES[now.weather_code] ?? "unknown conditions",
  };
}
