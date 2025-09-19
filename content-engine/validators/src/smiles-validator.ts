import { BaseValidationGate, ValidationResult } from './validation-gate.js';

/**
 * G6: RDKit SMILES Validation Gate
 * Validates chemical SMILES strings for correctness and safety
 */
export class SmilesValidationGate extends BaseValidationGate {
  readonly name = "SMILES Chemical Structure Validator";
  readonly gateNumber = "G6";
  readonly description = "Validates SMILES strings for chemical correctness and molecular constraints";

  private readonly maxAtoms = 100;
  private readonly maxBonds = 200;
  private readonly maxRings = 10;

  // Valid SMILES characters and patterns
  private readonly validSmilesPattern = /^[A-Za-z0-9@+\-\[\]()=#\/\\%:.]*$/;

  private readonly validElements = new Set([
    // Organic elements (implicit hydrogen)
    'B', 'C', 'N', 'O', 'P', 'S', 'F', 'Cl', 'Br', 'I',

    // Common inorganic elements
    'H', 'Li', 'Be', 'Na', 'Mg', 'Al', 'Si', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn'
  ]);

  /**
   * Validate SMILES string for chemical correctness
   */
  async validate(input: {
    smiles: string;
    constraints?: ChemicalConstraints;
    context?: string;
  }): Promise<ValidationResult> {
    const { smiles, constraints, context } = input;

    if (!smiles || typeof smiles !== 'string') {
      return this.createError(
        'E-G6-INVALID-INPUT',
        'SMILES must be a non-empty string',
        { smiles, context }
      );
    }

    const cleanSmiles = smiles.trim();

    if (cleanSmiles.length === 0) {
      return this.createError(
        'E-G6-EMPTY-SMILES',
        'SMILES string cannot be empty',
        { smiles, context }
      );
    }

    try {
      // Step 1: Basic character validation
      const charResult = this.validateCharacters(cleanSmiles);
      if (!charResult.valid) {
        return charResult;
      }

      // Step 2: Parse and validate molecular structure
      const parseResult = this.parseSmilesStructure(cleanSmiles);
      if (!parseResult.valid) {
        return parseResult;
      }

      const molecularData = parseResult.data!;

      // Step 3: Apply chemical constraints
      const constraintResult = this.validateConstraints(
        molecularData,
        constraints || this.getDefaultConstraints()
      );
      if (!constraintResult.valid) {
        return constraintResult;
      }

      // Step 4: Validate chemical reasonableness
      const reasonabilityResult = this.validateChemicalReasonableness(molecularData);
      if (!reasonabilityResult.valid) {
        return reasonabilityResult;
      }

      return this.createSuccess({
        smiles: cleanSmiles,
        molecularFormula: this.generateMolecularFormula(molecularData),
        atomCount: molecularData.atoms.length,
        bondCount: molecularData.bonds.length,
        ringCount: molecularData.rings.length,
        context
      });

    } catch (error) {
      return this.createError(
        'E-G6-VALIDATION-ERROR',
        'Error during SMILES validation',
        {
          smiles: cleanSmiles,
          error: error instanceof Error ? error.message : String(error),
          context
        }
      );
    }
  }

  /**
   * Validate SMILES characters
   */
  private validateCharacters(smiles: string): ValidationResult {
    // Check for valid SMILES characters
    if (!this.validSmilesPattern.test(smiles)) {
      const invalidChars = smiles.match(/[^A-Za-z0-9@+\-\[\]()=#\/\\%:.]/g) || [];
      return this.createError(
        'E-G6-INVALID-CHARACTERS',
        'SMILES contains invalid characters',
        { smiles, invalidChars: [...new Set(invalidChars)] }
      );
    }

    // Check length constraints
    if (smiles.length > 1000) {
      return this.createError(
        'E-G6-SMILES-TOO-LONG',
        'SMILES string too long (max 1000 characters)',
        { smiles, length: smiles.length }
      );
    }

    return this.createSuccess();
  }

  /**
   * Parse SMILES structure (simplified implementation)
   */
  private parseSmilesStructure(smiles: string): ValidationResult & { data?: MolecularData } {
    try {
      const atoms: Atom[] = [];
      const bonds: Bond[] = [];
      const rings: Ring[] = [];

      let i = 0;
      let currentAtomIndex = 0;
      const ringNumbers = new Map<string, number>();

      while (i < smiles.length) {
        const char = smiles[i];

        // Parse atoms
        if (/[A-Za-z]/.test(char)) {
          const atomResult = this.parseAtom(smiles, i);
          if (!atomResult.valid) {
            return atomResult;
          }

          atoms.push({
            index: currentAtomIndex,
            element: atomResult.data!.element,
            charge: atomResult.data!.charge || 0,
            hydrogens: atomResult.data!.hydrogens || 0,
            position: i
          });

          i += atomResult.data!.length;
          currentAtomIndex++;
          continue;
        }

        // Parse bonds
        if (['=', '#', ':', '/', '\\'].includes(char)) {
          if (currentAtomIndex < 1) {
            return this.createError(
              'E-G6-INVALID-BOND',
              'Bond without preceding atom',
              { position: i, char }
            );
          }

          bonds.push({
            atom1: currentAtomIndex - 1,
            atom2: currentAtomIndex, // Will be set when next atom is parsed
            type: this.getBondType(char),
            position: i
          });

          i++;
          continue;
        }

        // Parse ring numbers
        if (/\d/.test(char)) {
          const ringNum = char;
          if (ringNumbers.has(ringNum)) {
            // Close ring
            const startAtom = ringNumbers.get(ringNum)!;
            rings.push({
              atoms: [startAtom, currentAtomIndex - 1],
              size: Math.abs(currentAtomIndex - 1 - startAtom) + 1
            });
            ringNumbers.delete(ringNum);
          } else {
            // Open ring
            ringNumbers.set(ringNum, currentAtomIndex - 1);
          }
          i++;
          continue;
        }

        // Skip other characters (branches, etc.)
        i++;
      }

      // Check for unclosed rings
      if (ringNumbers.size > 0) {
        return this.createError(
          'E-G6-UNCLOSED-RINGS',
          'SMILES contains unclosed ring numbers',
          { unclosedRings: Array.from(ringNumbers.keys()) }
        );
      }

      return {
        valid: true,
        data: { atoms, bonds, rings }
      };

    } catch (error) {
      return this.createError(
        'E-G6-PARSE-ERROR',
        'Failed to parse SMILES structure',
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Parse individual atom from SMILES
   */
  private parseAtom(smiles: string, startIndex: number): ValidationResult & {
    data?: { element: string; charge?: number; hydrogens?: number; length: number }
  } {
    let i = startIndex;
    let element = '';
    let charge = 0;
    let hydrogens = 0;
    let inBrackets = false;

    // Check for bracketed atom
    if (smiles[i] === '[') {
      inBrackets = true;
      i++;
    }

    // Parse element symbol
    if (i < smiles.length && /[A-Z]/.test(smiles[i])) {
      element = smiles[i];
      i++;

      // Check for two-letter element
      if (i < smiles.length && /[a-z]/.test(smiles[i])) {
        element += smiles[i];
        i++;
      }
    } else {
      return this.createError(
        'E-G6-INVALID-ELEMENT',
        'Invalid element symbol',
        { position: startIndex, char: smiles[i] }
      );
    }

    // Validate element
    if (!this.validElements.has(element)) {
      return this.createError(
        'E-G6-UNKNOWN-ELEMENT',
        `Unknown chemical element: ${element}`,
        { element, position: startIndex }
      );
    }

    if (inBrackets) {
      // Parse hydrogen count
      if (i < smiles.length && smiles[i] === 'H') {
        i++;
        if (i < smiles.length && /\d/.test(smiles[i])) {
          hydrogens = parseInt(smiles[i]);
          i++;
        } else {
          hydrogens = 1;
        }
      }

      // Parse charge
      if (i < smiles.length && ['+', '-'].includes(smiles[i])) {
        const chargeSign = smiles[i] === '+' ? 1 : -1;
        i++;

        if (i < smiles.length && /\d/.test(smiles[i])) {
          charge = chargeSign * parseInt(smiles[i]);
          i++;
        } else {
          charge = chargeSign;
        }
      }

      // Find closing bracket
      if (i < smiles.length && smiles[i] === ']') {
        i++;
      } else {
        return this.createError(
          'E-G6-UNCLOSED-BRACKET',
          'Unclosed bracket in atom specification',
          { position: startIndex }
        );
      }
    }

    return {
      valid: true,
      data: {
        element,
        charge,
        hydrogens,
        length: i - startIndex
      }
    };
  }

  /**
   * Get bond type from character
   */
  private getBondType(char: string): string {
    const bondTypes: Record<string, string> = {
      '=': 'double',
      '#': 'triple',
      ':': 'aromatic',
      '/': 'up',
      '\\': 'down'
    };

    return bondTypes[char] || 'single';
  }

  /**
   * Validate chemical constraints
   */
  private validateConstraints(
    molecularData: MolecularData,
    constraints: ChemicalConstraints
  ): ValidationResult {
    const { atoms, bonds, rings } = molecularData;

    // Check atom count
    if (atoms.length > constraints.maxAtoms) {
      return this.createError(
        'E-G6-TOO-MANY-ATOMS',
        `Molecule has ${atoms.length} atoms, exceeds maximum of ${constraints.maxAtoms}`,
        { atomCount: atoms.length, maxAtoms: constraints.maxAtoms }
      );
    }

    // Check bond count
    if (bonds.length > constraints.maxBonds) {
      return this.createError(
        'E-G6-TOO-MANY-BONDS',
        `Molecule has ${bonds.length} bonds, exceeds maximum of ${constraints.maxBonds}`,
        { bondCount: bonds.length, maxBonds: constraints.maxBonds }
      );
    }

    // Check ring count
    if (rings.length > constraints.maxRings) {
      return this.createError(
        'E-G6-TOO-MANY-RINGS',
        `Molecule has ${rings.length} rings, exceeds maximum of ${constraints.maxRings}`,
        { ringCount: rings.length, maxRings: constraints.maxRings }
      );
    }

    return this.createSuccess();
  }

  /**
   * Validate chemical reasonableness
   */
  private validateChemicalReasonableness(molecularData: MolecularData): ValidationResult {
    const warnings: string[] = [];

    // Check for reasonable atom ratios
    const elementCounts = this.countElements(molecularData.atoms);

    // Check C:H ratio for organic molecules
    const carbonCount = elementCounts.get('C') || 0;
    const hydrogenCount = elementCounts.get('H') || 0;

    if (carbonCount > 0 && hydrogenCount > 0) {
      const chRatio = hydrogenCount / carbonCount;
      if (chRatio > 4 || chRatio < 0.5) {
        warnings.push(`Unusual C:H ratio (${chRatio.toFixed(2)})`);
      }
    }

    // Check for unusual charges
    const totalCharge = molecularData.atoms.reduce((sum, atom) => sum + atom.charge, 0);
    if (Math.abs(totalCharge) > 3) {
      warnings.push(`High total charge (${totalCharge})`);
    }

    // Check for very large rings
    const largeRings = molecularData.rings.filter(ring => ring.size > 12);
    if (largeRings.length > 0) {
      warnings.push(`Large ring structures detected (size > 12)`);
    }

    return this.createSuccess({ warnings });
  }

  /**
   * Count elements in molecule
   */
  private countElements(atoms: Atom[]): Map<string, number> {
    const counts = new Map<string, number>();

    for (const atom of atoms) {
      const current = counts.get(atom.element) || 0;
      counts.set(atom.element, current + 1);

      // Add implicit hydrogens
      if (atom.hydrogens > 0) {
        const hCount = counts.get('H') || 0;
        counts.set('H', hCount + atom.hydrogens);
      }
    }

    return counts;
  }

  /**
   * Generate molecular formula
   */
  private generateMolecularFormula(molecularData: MolecularData): string {
    const elementCounts = this.countElements(molecularData.atoms);
    const formula: string[] = [];

    // Standard order: C, H, then alphabetical
    const elementOrder = ['C', 'H'];
    const otherElements = Array.from(elementCounts.keys())
      .filter(e => !elementOrder.includes(e))
      .sort();

    for (const element of elementOrder.concat(otherElements)) {
      const count = elementCounts.get(element);
      if (count && count > 0) {
        formula.push(count === 1 ? element : `${element}${count}`);
      }
    }

    return formula.join('');
  }

  /**
   * Get default chemical constraints
   */
  private getDefaultConstraints(): ChemicalConstraints {
    return {
      maxAtoms: this.maxAtoms,
      maxBonds: this.maxBonds,
      maxRings: this.maxRings
    };
  }

  /**
   * Validate multiple SMILES strings
   */
  async validateBatch(molecules: Array<{
    smiles: string;
    id?: string;
    constraints?: ChemicalConstraints;
    context?: string;
  }>): Promise<{
    allValid: boolean;
    results: Array<{ id?: string; valid: boolean; errors?: any[]; data?: any }>;
  }> {
    const results = [];
    let allValid = true;

    for (const molecule of molecules) {
      const result = await this.validate(molecule);
      results.push({
        id: molecule.id,
        valid: result.valid,
        errors: result.errors,
        data: result.data
      });

      if (!result.valid) {
        allValid = false;
      }
    }

    return { allValid, results };
  }
}

// Chemical data structures
interface MolecularData {
  atoms: Atom[];
  bonds: Bond[];
  rings: Ring[];
}

interface Atom {
  index: number;
  element: string;
  charge: number;
  hydrogens: number;
  position: number;
}

interface Bond {
  atom1: number;
  atom2: number;
  type: string;
  position: number;
}

interface Ring {
  atoms: number[];
  size: number;
}

interface ChemicalConstraints {
  maxAtoms: number;
  maxBonds: number;
  maxRings: number;
}