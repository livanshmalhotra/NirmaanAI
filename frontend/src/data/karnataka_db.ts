/**
 * Karnataka District Engineering Database
 * Synthetic data for simulation analysis.
 * Values are calibrated to real-world Karnataka geography.
 */

export interface SeismicData {
  zone: 'II' | 'III' | 'IV';
  zoneDescription: string;
  peakGroundAcceleration: number;   // g (fraction)
  soilType: 'Hard' | 'Medium' | 'Soft';
  responseSpectrum: number;          // Sa/g at 0.3s
  dampingRatio: number;              // %
  designBaseShear: number;           // kN per floor (per 1000 sqft)
  structuralRisk: 'Low' | 'Moderate' | 'High';
}

export interface ThermalData {
  climateZone: 'Hot-Dry' | 'Hot-Humid' | 'Composite' | 'Temperate';
  avgSummerTempC: number;
  avgWinterTempC: number;
  solarRadiation: number;            // W/m²
  humidityPct: number;               // avg annual %
  coolingDegreeDays: number;
  heatingDegreeDays: number;
  uValueWall: number;                // W/m²K — recommended
  uValueRoof: number;
  annualCoolingLoadKwh: number;      // per 100 sqm
  thermalComfortIndex: number;       // 0–10, higher = harder to cool
}

export interface WindData {
  basicWindSpeed: number;            // km/h (IS:875 Part 3)
  designWindSpeed: number;           // km/h after terrain factor
  terrainCategory: 1 | 2 | 3 | 4;
  windPressure: number;              // N/m²
  cycloneProbability: 'Very Low' | 'Low' | 'Moderate' | 'High';
  topographyFactor: number;          // k2 factor
  structuralWindIndex: number;       // 0–10, higher = more risk
}

export interface ElectricalData {
  gridReliabilityPct: number;        // % uptime
  avgTariffPerUnit: number;          // ₹/kWh
  peakLoadFactor: number;            // peak/avg demand ratio
  powerFactor: number;               // typical PF in area
  voltageFluctuationPct: number;     // ± % variation
  renewableMixPct: number;           // % renewable in state grid
  connectedLoadPerFloor: number;     // kW per standard floor
  demandDiversityFactor: number;     // 0–1
  recommendedGeneratorKva: number;   // backup generator size
  transformerUtilizationPct: number;
}

export interface DistrictData {
  id: string;
  name: string;
  region: string;
  population: number;
  avgAltitudeM: number;
  seismic: SeismicData;
  thermal: ThermalData;
  wind: WindData;
  electrical: ElectricalData;
}

const DB: DistrictData[] = [
  {
    id: 'bengaluru-urban',
    name: 'Bengaluru Urban',
    region: 'South Karnataka',
    population: 13193000,
    avgAltitudeM: 920,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.40, dampingRatio: 5,
      designBaseShear: 28.5, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Composite', avgSummerTempC: 33, avgWinterTempC: 15,
      solarRadiation: 210, humidityPct: 63, coolingDegreeDays: 1430, heatingDegreeDays: 90,
      uValueWall: 0.40, uValueRoof: 0.30, annualCoolingLoadKwh: 980, thermalComfortIndex: 5.2,
    },
    wind: {
      basicWindSpeed: 33, designWindSpeed: 39, terrainCategory: 3,
      windPressure: 465, cycloneProbability: 'Very Low', topographyFactor: 1.05,
      structuralWindIndex: 3.1,
    },
    electrical: {
      gridReliabilityPct: 97.2, avgTariffPerUnit: 7.8, peakLoadFactor: 1.62,
      powerFactor: 0.92, voltageFluctuationPct: 4.5, renewableMixPct: 58,
      connectedLoadPerFloor: 14.5, demandDiversityFactor: 0.72,
      recommendedGeneratorKva: 62.5, transformerUtilizationPct: 71,
    },
  },
  {
    id: 'mysuru',
    name: 'Mysuru',
    region: 'South Karnataka',
    population: 3020000,
    avgAltitudeM: 763,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Medium',
      responseSpectrum: 1.60, dampingRatio: 5,
      designBaseShear: 26.2, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 36, avgWinterTempC: 17,
      solarRadiation: 225, humidityPct: 55, coolingDegreeDays: 1620, heatingDegreeDays: 60,
      uValueWall: 0.35, uValueRoof: 0.25, annualCoolingLoadKwh: 1180, thermalComfortIndex: 6.1,
    },
    wind: {
      basicWindSpeed: 33, designWindSpeed: 38, terrainCategory: 3,
      windPressure: 445, cycloneProbability: 'Very Low', topographyFactor: 1.02,
      structuralWindIndex: 2.8,
    },
    electrical: {
      gridReliabilityPct: 95.8, avgTariffPerUnit: 7.6, peakLoadFactor: 1.58,
      powerFactor: 0.89, voltageFluctuationPct: 6.1, renewableMixPct: 54,
      connectedLoadPerFloor: 13.2, demandDiversityFactor: 0.70,
      recommendedGeneratorKva: 50, transformerUtilizationPct: 68,
    },
  },
  {
    id: 'mangaluru',
    name: 'Mangaluru (Dakshina Kannada)',
    region: 'Coastal Karnataka',
    population: 2086000,
    avgAltitudeM: 22,
    seismic: {
      zone: 'III', zoneDescription: 'Moderate seismic hazard — coastal zone',
      peakGroundAcceleration: 0.16, soilType: 'Soft',
      responseSpectrum: 2.10, dampingRatio: 5,
      designBaseShear: 48.8, structuralRisk: 'Moderate',
    },
    thermal: {
      climateZone: 'Hot-Humid', avgSummerTempC: 34, avgWinterTempC: 24,
      solarRadiation: 195, humidityPct: 84, coolingDegreeDays: 2100, heatingDegreeDays: 0,
      uValueWall: 0.45, uValueRoof: 0.35, annualCoolingLoadKwh: 1540, thermalComfortIndex: 8.4,
    },
    wind: {
      basicWindSpeed: 50, designWindSpeed: 60, terrainCategory: 2,
      windPressure: 1100, cycloneProbability: 'Moderate', topographyFactor: 1.12,
      structuralWindIndex: 7.5,
    },
    electrical: {
      gridReliabilityPct: 93.5, avgTariffPerUnit: 8.1, peakLoadFactor: 1.72,
      powerFactor: 0.87, voltageFluctuationPct: 8.3, renewableMixPct: 48,
      connectedLoadPerFloor: 16.8, demandDiversityFactor: 0.68,
      recommendedGeneratorKva: 75, transformerUtilizationPct: 78,
    },
  },
  {
    id: 'belagavi',
    name: 'Belagavi',
    region: 'North Karnataka',
    population: 4816000,
    avgAltitudeM: 747,
    seismic: {
      zone: 'III', zoneDescription: 'Moderate seismic hazard — Deccan trap region',
      peakGroundAcceleration: 0.16, soilType: 'Medium',
      responseSpectrum: 1.80, dampingRatio: 5,
      designBaseShear: 42.0, structuralRisk: 'Moderate',
    },
    thermal: {
      climateZone: 'Composite', avgSummerTempC: 38, avgWinterTempC: 12,
      solarRadiation: 230, humidityPct: 58, coolingDegreeDays: 1750, heatingDegreeDays: 180,
      uValueWall: 0.38, uValueRoof: 0.28, annualCoolingLoadKwh: 1250, thermalComfortIndex: 6.8,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 47, terrainCategory: 2,
      windPressure: 680, cycloneProbability: 'Very Low', topographyFactor: 1.08,
      structuralWindIndex: 4.8,
    },
    electrical: {
      gridReliabilityPct: 91.2, avgTariffPerUnit: 7.5, peakLoadFactor: 1.65,
      powerFactor: 0.88, voltageFluctuationPct: 9.5, renewableMixPct: 42,
      connectedLoadPerFloor: 12.8, demandDiversityFactor: 0.65,
      recommendedGeneratorKva: 50, transformerUtilizationPct: 65,
    },
  },
  {
    id: 'dharwad',
    name: 'Dharwad',
    region: 'North Karnataka',
    population: 1847000,
    avgAltitudeM: 741,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.42, dampingRatio: 5,
      designBaseShear: 27.0, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 40, avgWinterTempC: 14,
      solarRadiation: 245, humidityPct: 48, coolingDegreeDays: 1900, heatingDegreeDays: 140,
      uValueWall: 0.33, uValueRoof: 0.24, annualCoolingLoadKwh: 1380, thermalComfortIndex: 7.2,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 44, terrainCategory: 3,
      windPressure: 595, cycloneProbability: 'Very Low', topographyFactor: 1.05,
      structuralWindIndex: 4.1,
    },
    electrical: {
      gridReliabilityPct: 90.5, avgTariffPerUnit: 7.4, peakLoadFactor: 1.60,
      powerFactor: 0.87, voltageFluctuationPct: 10.2, renewableMixPct: 38,
      connectedLoadPerFloor: 12.0, demandDiversityFactor: 0.64,
      recommendedGeneratorKva: 50, transformerUtilizationPct: 62,
    },
  },
  {
    id: 'ballari',
    name: 'Ballari',
    region: 'North Karnataka',
    population: 2530000,
    avgAltitudeM: 447,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard — stable Deccan plateau',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.38, dampingRatio: 5,
      designBaseShear: 25.8, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 42, avgWinterTempC: 18,
      solarRadiation: 260, humidityPct: 42, coolingDegreeDays: 2100, heatingDegreeDays: 80,
      uValueWall: 0.30, uValueRoof: 0.22, annualCoolingLoadKwh: 1620, thermalComfortIndex: 8.1,
    },
    wind: {
      basicWindSpeed: 33, designWindSpeed: 38, terrainCategory: 3,
      windPressure: 440, cycloneProbability: 'Very Low', topographyFactor: 1.02,
      structuralWindIndex: 2.9,
    },
    electrical: {
      gridReliabilityPct: 88.0, avgTariffPerUnit: 7.3, peakLoadFactor: 1.78,
      powerFactor: 0.85, voltageFluctuationPct: 12.5, renewableMixPct: 35,
      connectedLoadPerFloor: 15.5, demandDiversityFactor: 0.61,
      recommendedGeneratorKva: 62.5, transformerUtilizationPct: 74,
    },
  },
  {
    id: 'shivamogga',
    name: 'Shivamogga',
    region: 'Malnad / Western Ghats',
    population: 1755000,
    avgAltitudeM: 575,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Medium',
      responseSpectrum: 1.55, dampingRatio: 5,
      designBaseShear: 30.2, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Humid', avgSummerTempC: 35, avgWinterTempC: 18,
      solarRadiation: 185, humidityPct: 80, coolingDegreeDays: 1820, heatingDegreeDays: 10,
      uValueWall: 0.42, uValueRoof: 0.32, annualCoolingLoadKwh: 1390, thermalComfortIndex: 7.6,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 46, terrainCategory: 2,
      windPressure: 650, cycloneProbability: 'Low', topographyFactor: 1.10,
      structuralWindIndex: 5.2,
    },
    electrical: {
      gridReliabilityPct: 92.0, avgTariffPerUnit: 7.6, peakLoadFactor: 1.62,
      powerFactor: 0.88, voltageFluctuationPct: 8.0, renewableMixPct: 50,
      connectedLoadPerFloor: 13.5, demandDiversityFactor: 0.66,
      recommendedGeneratorKva: 50, transformerUtilizationPct: 66,
    },
  },
  {
    id: 'hassan',
    name: 'Hassan',
    region: 'South Karnataka',
    population: 1776000,
    avgAltitudeM: 985,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard — high plateau',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.40, dampingRatio: 5,
      designBaseShear: 27.5, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Temperate', avgSummerTempC: 30, avgWinterTempC: 13,
      solarRadiation: 200, humidityPct: 68, coolingDegreeDays: 1150, heatingDegreeDays: 200,
      uValueWall: 0.45, uValueRoof: 0.35, annualCoolingLoadKwh: 820, thermalComfortIndex: 4.2,
    },
    wind: {
      basicWindSpeed: 33, designWindSpeed: 39, terrainCategory: 3,
      windPressure: 465, cycloneProbability: 'Very Low', topographyFactor: 1.05,
      structuralWindIndex: 3.2,
    },
    electrical: {
      gridReliabilityPct: 93.0, avgTariffPerUnit: 7.5, peakLoadFactor: 1.55,
      powerFactor: 0.90, voltageFluctuationPct: 7.2, renewableMixPct: 55,
      connectedLoadPerFloor: 11.8, demandDiversityFactor: 0.68,
      recommendedGeneratorKva: 37.5, transformerUtilizationPct: 60,
    },
  },
  {
    id: 'tumakuru',
    name: 'Tumakuru',
    region: 'South Karnataka',
    population: 2678000,
    avgAltitudeM: 820,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.42, dampingRatio: 5,
      designBaseShear: 26.8, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 37, avgWinterTempC: 16,
      solarRadiation: 235, humidityPct: 52, coolingDegreeDays: 1780, heatingDegreeDays: 70,
      uValueWall: 0.34, uValueRoof: 0.26, annualCoolingLoadKwh: 1280, thermalComfortIndex: 6.5,
    },
    wind: {
      basicWindSpeed: 33, designWindSpeed: 40, terrainCategory: 3,
      windPressure: 490, cycloneProbability: 'Very Low', topographyFactor: 1.06,
      structuralWindIndex: 3.4,
    },
    electrical: {
      gridReliabilityPct: 94.5, avgTariffPerUnit: 7.6, peakLoadFactor: 1.60,
      powerFactor: 0.89, voltageFluctuationPct: 6.8, renewableMixPct: 52,
      connectedLoadPerFloor: 13.0, demandDiversityFactor: 0.69,
      recommendedGeneratorKva: 50, transformerUtilizationPct: 64,
    },
  },
  {
    id: 'kalaburagi',
    name: 'Kalaburagi',
    region: 'Hyderabad Karnataka',
    population: 2556000,
    avgAltitudeM: 454,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard — stable basalt',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.36, dampingRatio: 5,
      designBaseShear: 24.5, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 42, avgWinterTempC: 17,
      solarRadiation: 255, humidityPct: 45, coolingDegreeDays: 2200, heatingDegreeDays: 90,
      uValueWall: 0.29, uValueRoof: 0.21, annualCoolingLoadKwh: 1720, thermalComfortIndex: 8.6,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 45, terrainCategory: 2,
      windPressure: 620, cycloneProbability: 'Very Low', topographyFactor: 1.06,
      structuralWindIndex: 4.5,
    },
    electrical: {
      gridReliabilityPct: 85.5, avgTariffPerUnit: 7.2, peakLoadFactor: 1.82,
      powerFactor: 0.84, voltageFluctuationPct: 14.0, renewableMixPct: 30,
      connectedLoadPerFloor: 16.2, demandDiversityFactor: 0.60,
      recommendedGeneratorKva: 75, transformerUtilizationPct: 80,
    },
  },
  {
    id: 'raichur',
    name: 'Raichur',
    region: 'Hyderabad Karnataka',
    population: 1923000,
    avgAltitudeM: 397,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Medium',
      responseSpectrum: 1.48, dampingRatio: 5,
      designBaseShear: 24.0, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 44, avgWinterTempC: 18,
      solarRadiation: 265, humidityPct: 40, coolingDegreeDays: 2380, heatingDegreeDays: 60,
      uValueWall: 0.28, uValueRoof: 0.20, annualCoolingLoadKwh: 1860, thermalComfortIndex: 9.0,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 44, terrainCategory: 2,
      windPressure: 595, cycloneProbability: 'Very Low', topographyFactor: 1.04,
      structuralWindIndex: 4.2,
    },
    electrical: {
      gridReliabilityPct: 84.0, avgTariffPerUnit: 7.1, peakLoadFactor: 1.88,
      powerFactor: 0.83, voltageFluctuationPct: 15.5, renewableMixPct: 28,
      connectedLoadPerFloor: 17.5, demandDiversityFactor: 0.58,
      recommendedGeneratorKva: 75, transformerUtilizationPct: 84,
    },
  },
  {
    id: 'bidar',
    name: 'Bidar',
    region: 'Hyderabad Karnataka',
    population: 1703000,
    avgAltitudeM: 664,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Medium',
      responseSpectrum: 1.50, dampingRatio: 5,
      designBaseShear: 25.0, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 40, avgWinterTempC: 13,
      solarRadiation: 248, humidityPct: 47, coolingDegreeDays: 1980, heatingDegreeDays: 160,
      uValueWall: 0.32, uValueRoof: 0.23, annualCoolingLoadKwh: 1480, thermalComfortIndex: 7.8,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 45, terrainCategory: 2,
      windPressure: 620, cycloneProbability: 'Very Low', topographyFactor: 1.06,
      structuralWindIndex: 4.4,
    },
    electrical: {
      gridReliabilityPct: 83.5, avgTariffPerUnit: 7.1, peakLoadFactor: 1.80,
      powerFactor: 0.83, voltageFluctuationPct: 14.8, renewableMixPct: 28,
      connectedLoadPerFloor: 14.8, demandDiversityFactor: 0.59,
      recommendedGeneratorKva: 62.5, transformerUtilizationPct: 76,
    },
  },
  {
    id: 'uttara-kannada',
    name: 'Uttara Kannada',
    region: 'Coastal Karnataka',
    population: 1436000,
    avgAltitudeM: 45,
    seismic: {
      zone: 'III', zoneDescription: 'Moderate seismic hazard — coastal rift zone',
      peakGroundAcceleration: 0.16, soilType: 'Soft',
      responseSpectrum: 2.20, dampingRatio: 5,
      designBaseShear: 52.0, structuralRisk: 'Moderate',
    },
    thermal: {
      climateZone: 'Hot-Humid', avgSummerTempC: 33, avgWinterTempC: 22,
      solarRadiation: 190, humidityPct: 86, coolingDegreeDays: 2050, heatingDegreeDays: 0,
      uValueWall: 0.46, uValueRoof: 0.36, annualCoolingLoadKwh: 1480, thermalComfortIndex: 8.2,
    },
    wind: {
      basicWindSpeed: 50, designWindSpeed: 62, terrainCategory: 2,
      windPressure: 1180, cycloneProbability: 'High', topographyFactor: 1.14,
      structuralWindIndex: 8.5,
    },
    electrical: {
      gridReliabilityPct: 89.0, avgTariffPerUnit: 7.9, peakLoadFactor: 1.70,
      powerFactor: 0.86, voltageFluctuationPct: 11.0, renewableMixPct: 52,
      connectedLoadPerFloor: 14.0, demandDiversityFactor: 0.64,
      recommendedGeneratorKva: 62.5, transformerUtilizationPct: 70,
    },
  },
  {
    id: 'udupi',
    name: 'Udupi',
    region: 'Coastal Karnataka',
    population: 1177000,
    avgAltitudeM: 18,
    seismic: {
      zone: 'III', zoneDescription: 'Moderate seismic hazard — coastal alluvial',
      peakGroundAcceleration: 0.16, soilType: 'Soft',
      responseSpectrum: 2.15, dampingRatio: 5,
      designBaseShear: 50.5, structuralRisk: 'Moderate',
    },
    thermal: {
      climateZone: 'Hot-Humid', avgSummerTempC: 33, avgWinterTempC: 23,
      solarRadiation: 192, humidityPct: 85, coolingDegreeDays: 2080, heatingDegreeDays: 0,
      uValueWall: 0.45, uValueRoof: 0.35, annualCoolingLoadKwh: 1520, thermalComfortIndex: 8.3,
    },
    wind: {
      basicWindSpeed: 50, designWindSpeed: 61, terrainCategory: 2,
      windPressure: 1140, cycloneProbability: 'High', topographyFactor: 1.13,
      structuralWindIndex: 8.2,
    },
    electrical: {
      gridReliabilityPct: 91.0, avgTariffPerUnit: 8.0, peakLoadFactor: 1.68,
      powerFactor: 0.87, voltageFluctuationPct: 9.5, renewableMixPct: 54,
      connectedLoadPerFloor: 15.2, demandDiversityFactor: 0.66,
      recommendedGeneratorKva: 62.5, transformerUtilizationPct: 72,
    },
  },
  {
    id: 'gadag',
    name: 'Gadag',
    region: 'North Karnataka',
    population: 1056000,
    avgAltitudeM: 656,
    seismic: {
      zone: 'II', zoneDescription: 'Low seismic hazard',
      peakGroundAcceleration: 0.10, soilType: 'Hard',
      responseSpectrum: 1.38, dampingRatio: 5,
      designBaseShear: 24.8, structuralRisk: 'Low',
    },
    thermal: {
      climateZone: 'Hot-Dry', avgSummerTempC: 41, avgWinterTempC: 15,
      solarRadiation: 250, humidityPct: 46, coolingDegreeDays: 2000, heatingDegreeDays: 120,
      uValueWall: 0.31, uValueRoof: 0.22, annualCoolingLoadKwh: 1520, thermalComfortIndex: 7.9,
    },
    wind: {
      basicWindSpeed: 39, designWindSpeed: 46, terrainCategory: 2,
      windPressure: 650, cycloneProbability: 'Very Low', topographyFactor: 1.07,
      structuralWindIndex: 4.7,
    },
    electrical: {
      gridReliabilityPct: 87.0, avgTariffPerUnit: 7.3, peakLoadFactor: 1.75,
      powerFactor: 0.85, voltageFluctuationPct: 13.0, renewableMixPct: 32,
      connectedLoadPerFloor: 14.5, demandDiversityFactor: 0.62,
      recommendedGeneratorKva: 62.5, transformerUtilizationPct: 75,
    },
  },
];

export const KARNATAKA_DISTRICTS = DB;

export function getDistrictById(id: string): DistrictData | undefined {
  return DB.find(d => d.id === id);
}

export function getDefaultDistrict(): DistrictData {
  return DB.find(d => d.id === 'bengaluru-urban')!;
}
