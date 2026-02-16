/**
 * Canned LLM JSON responses for each file type.
 * These are what chatCompletion would return for PDE materials.
 */

/** Lecture notes — lots of concepts, file-concept and concept-concept links */
export const lectureNotesResponse = {
	concepts: [
		{ name: "Method Of Characteristics", description: "Technique for solving first-order PDEs", aliases: "characteristics method, MOC" },
		{ name: "Heat Equation", description: "Parabolic PDE modelling diffusion", aliases: "diffusion equation" },
		{ name: "Wave Equation", description: "Hyperbolic PDE for wave propagation" },
		{ name: "Separation Of Variables", description: "Technique decomposing PDE into ODEs" },
		{ name: "Fourier Series", description: "Representation of periodic functions" },
		{ name: "D'Alembert's Solution", description: "Explicit solution for the 1D wave equation", aliases: "d'Alembert formula" },
		{ name: "Sturm-Liouville Theory", description: "Eigenvalue problems for second-order ODEs" },
		{ name: "Boundary Value Problems", description: "PDEs with boundary conditions", aliases: "BVP" },
	],
	file_concept_links: [
		{ conceptName: "Method Of Characteristics", relationship: "introduces", confidence: 0.95 },
		{ conceptName: "Heat Equation", relationship: "covers", confidence: 0.9 },
		{ conceptName: "Wave Equation", relationship: "covers", confidence: 0.9 },
		{ conceptName: "Separation Of Variables", relationship: "introduces", confidence: 0.85 },
		{ conceptName: "Fourier Series", relationship: "covers", confidence: 0.8 },
		{ conceptName: "D'Alembert's Solution", relationship: "introduces", confidence: 0.85 },
		{ conceptName: "Sturm-Liouville Theory", relationship: "covers", confidence: 0.75 },
		{ conceptName: "Boundary Value Problems", relationship: "covers", confidence: 0.8 },
	],
	concept_concept_links: [
		{ sourceConcept: "Separation Of Variables", targetConcept: "Fourier Series", relationship: "prerequisite", confidence: 0.85 },
		{ sourceConcept: "Heat Equation", targetConcept: "Wave Equation", relationship: "related_to", confidence: 0.7 },
		{ sourceConcept: "D'Alembert's Solution", targetConcept: "Wave Equation", relationship: "special_case_of", confidence: 0.9 },
		{ sourceConcept: "Sturm-Liouville Theory", targetConcept: "Separation Of Variables", relationship: "prerequisite", confidence: 0.8 },
	],
	question_concept_links: [],
};

/** Past paper — heavy on question-concept links */
export const pastPaperResponse = {
	concepts: [
		{ name: "Method Of Characteristics", description: "Technique for solving first-order PDEs" },
		{ name: "Heat Equation", description: "Parabolic PDE modelling diffusion" },
		{ name: "Well-Posedness", description: "Existence, uniqueness and stability in the sense of Hadamard", aliases: "Hadamard well-posedness" },
	],
	file_concept_links: [
		{ conceptName: "Method Of Characteristics", relationship: "applies", confidence: 0.9 },
		{ conceptName: "Heat Equation", relationship: "applies", confidence: 0.85 },
		{ conceptName: "Well-Posedness", relationship: "references", confidence: 0.8 },
	],
	concept_concept_links: [],
	question_concept_links: [
		{ questionLabel: "Q1(a)", conceptName: "Method Of Characteristics", relationship: "tests", confidence: 0.9 },
		{ questionLabel: "Q1(b)", conceptName: "Well-Posedness", relationship: "tests", confidence: 0.85 },
		{ questionLabel: "Q2", conceptName: "Heat Equation", relationship: "applies", confidence: 0.85 },
	],
};

/** Problem sheet — mix of both */
export const problemSheetResponse = {
	concepts: [
		{ name: "Method Of Characteristics", description: "Technique for solving first-order PDEs" },
		{ name: "Separation Of Variables", description: "Technique decomposing PDE into ODEs" },
		{ name: "Heat Equation", description: "Parabolic PDE modelling diffusion" },
	],
	file_concept_links: [
		{ conceptName: "Method Of Characteristics", relationship: "applies", confidence: 0.85 },
		{ conceptName: "Separation Of Variables", relationship: "applies", confidence: 0.85 },
		{ conceptName: "Heat Equation", relationship: "applies", confidence: 0.8 },
	],
	concept_concept_links: [
		{ sourceConcept: "Separation Of Variables", targetConcept: "Heat Equation", relationship: "related_to", confidence: 0.7 },
	],
	question_concept_links: [
		{ questionLabel: "Q1", conceptName: "Method Of Characteristics", relationship: "tests", confidence: 0.85 },
		{ questionLabel: "Q2", conceptName: "Separation Of Variables", relationship: "applies", confidence: 0.8 },
	],
};

/** Response with unknown concept names in links — for error handling test */
export const responseWithUnknownConcepts = {
	concepts: [
		{ name: "Heat Equation", description: "Parabolic PDE" },
	],
	file_concept_links: [
		{ conceptName: "Heat Equation", relationship: "covers", confidence: 0.9 },
		{ conceptName: "Quantum Field Theory", relationship: "covers", confidence: 0.8 },
	],
	concept_concept_links: [
		{ sourceConcept: "Heat Equation", targetConcept: "String Theory", relationship: "related_to", confidence: 0.5 },
	],
	question_concept_links: [
		{ questionLabel: "Q1", conceptName: "Nonexistent Concept", relationship: "tests", confidence: 0.7 },
	],
};
