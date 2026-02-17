/**
 * PDE Midterm session factory — re-exports seedPdeSession from helpers.
 * This file also contains the concept list used across fixtures.
 */

export { seedPdeSession } from "./helpers.js";

/** Expected concepts that the LLM would extract from PDE materials */
export const PDE_CONCEPTS = [
	{
		name: "Method Of Characteristics",
		description: "Technique for solving first-order PDEs",
		aliases: "characteristics method, MOC",
	},
	{
		name: "Heat Equation",
		description: "Parabolic PDE modelling diffusion",
		aliases: "diffusion equation",
	},
	{ name: "Wave Equation", description: "Hyperbolic PDE for wave propagation", aliases: "" },
	{
		name: "Separation Of Variables",
		description: "Technique decomposing PDE into ODEs",
		aliases: "",
	},
	{ name: "Fourier Series", description: "Representation of periodic functions", aliases: "" },
	{
		name: "Fourier Transform",
		description: "Integral transform for frequency analysis",
		aliases: "",
	},
	{
		name: "Green's Function",
		description: "Fundamental solution for linear operators",
		aliases: "Green function",
	},
	{ name: "Boundary Value Problems", description: "PDEs with boundary conditions", aliases: "BVP" },
	{
		name: "Initial Value Problems",
		description: "PDEs with initial conditions",
		aliases: "IVP, Cauchy problem",
	},
	{
		name: "D'Alembert's Solution",
		description: "Explicit solution for the 1D wave equation",
		aliases: "d'Alembert formula",
	},
	{
		name: "Sturm-Liouville Theory",
		description: "Eigenvalue problems for second-order ODEs",
		aliases: "",
	},
	{
		name: "Well-Posedness",
		description: "Existence, uniqueness and stability in the sense of Hadamard",
		aliases: "Hadamard well-posedness",
	},
	{
		name: "Maximum Principle",
		description: "Maximum/minimum of solutions on the boundary",
		aliases: "",
	},
	{
		name: "Energy Methods",
		description: "Techniques using energy functionals for uniqueness/stability",
		aliases: "",
	},
	{
		name: "Laplace's Equation",
		description: "Elliptic PDE for harmonic functions",
		aliases: "Laplace equation",
	},
];
