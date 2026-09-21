/**
 * Environmental channels beyond CO2, per the 2026-09-20 review.
 *
 * VERIFIED inputs:
 *   eGRID2023 US average output rates, lb/MWh: CO2 767.2, CH4 0.057, N2O 0.008, SO2 0.359
 *     (NOx 0.452 reported in the review; eGRID publishes it, not independently re-read here)
 *   LBNL 2024 US Data Center Energy Usage Report: 176 TWh in 2023, 66 bn L direct water
 *     consumption -> 0.375 L/kWh direct; ~800 bn L indirect via generation -> 4.55 L/kWh
 *   Boavizta platform_compute_medium embedded 900 kg CO2e (462-2,089)
 *   EIA 2025 US generation mix: ~41% gas + 17% coal + 0.7% petroleum = 58.7% fossil
 */
import { num, sweep } from './args.js';
import { f, nr, r } from './fmt.js';

const SITES = sweep('sites', [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]);

const LB_KG = 0.45359237;
const EG = { CO2: 767.2, CH4: 0.057, N2O: 0.008, NOx: 0.452, SO2: 0.359 }; // lb/MWh
const W_DIRECT = 0.375;
const W_INDIRECT = 4.55; // L/kWh
const FOSSIL = 0.587;
const EMBODIED_KG = 900.0;
const LIFE_Y = 4.0;
const SERVER_KG = 21.67;
const IDLE_W = 135.0;
const PUE = 1.54;
const HOURS_Y = 8766.0;
const DENSITY = num('density', 233.0); // Pantheon-realistic sites per host

const co2e = EG.CO2 + EG.CH4 * 28 + EG.N2O * 265;
process.stdout.write('non-CO2 GHG share of eGRID CO2e: ');
console.log(
	`${f(((co2e - EG.CO2) / co2e) * 100, 2)}%  <- why a CO2-only climate figure was not far wrong\n`
);

type Channels = Record<string, number>;

function channels(sites: number): Channels {
	const hosts = sites / DENSITY;
	const mwh = (hosts * IDLE_W * PUE * HOURS_Y) / 1000.0 / 1000.0;
	const kwh = mwh * 1000;
	const out: Channels = {};
	for (const [k, v] of Object.entries(EG)) out[k] = mwh * v * LB_KG; // kg
	out.water_ML = (kwh * (W_DIRECT + W_INDIRECT)) / 1e6; // megalitres
	out.fossil_GWh = (mwh * FOSSIL) / 1000.0;
	out.embodied_t = (hosts * EMBODIED_KG) / LIFE_Y / 1000.0;
	out.hardware_t = (hosts * SERVER_KG) / 1000.0;
	out.hosts = hosts;
	out.MWh = mwh;
	return out;
}

console.log(
	`${r('sites', 12)} ${r('hosts', 8)} ${r('MWh/y', 9)} ${r('CO2 t/y', 9)} ${r('water ML/y', 11)} ${r('fossil GWh/y', 13)} ${r('NOx kg', 8)} ${r('SO2 kg', 8)} ${r('hw tonnes', 10)}`
);
for (const sites of SITES) {
	const c = channels(sites);
	console.log(
		`${nr(sites, 12)} ${nr(c.hosts!, 8)} ${nr(c.MWh!, 9)} ${nr(c.CO2! / 1000, 9)} ` +
			`${nr(c.water_ML!, 11, 2)} ${nr(c.fossil_GWh!, 13, 2)} ${nr(c.NOx!, 8)} ${nr(c.SO2!, 8)} ${nr(c.hardware_t!, 10)}`
	);
}

console.log('\nDartmouth, 3,375 student sites:');
const c = channels(3375);
console.log(
	`  ${f(c.hosts!, 1)} hosts, ${f(c.MWh!, 1)} MWh/y, ${f(c.CO2! / 1000, 1)} t CO2/y, ` +
		`${nr(c.water_ML! * 1e6, 0)} L water/y, ${nr(c.hardware_t! * 1000, 0)} kg hardware`
);
console.log(
	`  water in US household terms (~300 L/day): ${f((c.water_ML! * 1e6) / (300 * 365), 1)} households`
);

console.log('\nthe three metrics, what each is for:');
console.log('  economics    immediate    money and labour the institution stops spending');
console.log('  energy       structural   provisioned capacity that no longer has to exist');
console.log('  environment  systemic     what follows IF that capacity is genuinely retired');
