/**
 * G7: Diagram Topology Validation Gate
 * Validates diagram structure, node connectivity, and topological correctness
 */

import type { ValidationGate, ValidationResult } from '../types/validation.js';

export interface DiagramTopologyInput {
  nodes: Array<{
    id: string;
    label: string;
    shape: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label?: string;
    style?: string;
  }>;
  type: string;
}

export interface TopologyError {
  code: string;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}

export class DiagramTopologyValidationGate implements ValidationGate<DiagramTopologyInput> {
  async validate(input: DiagramTopologyInput): Promise<ValidationResult> {
    const errors: TopologyError[] = [];
    const warnings: string[] = [];

    try {
      // Basic structure validation
      this.validateBasicStructure(input, errors);

      // Node validation
      this.validateNodes(input.nodes, errors);

      // Edge validation
      this.validateEdges(input.nodes, input.edges, errors);

      // Topology validation
      this.validateTopology(input.nodes, input.edges, input.type, errors, warnings);

      return {
        valid: errors.length === 0,
        errors: errors.map(e => ({ message: e.message, code: e.code })),
        warnings
      };

    } catch (error) {
      return {
        valid: false,
        errors: [{
          message: `Diagram topology validation failed: ${error}`,
          code: 'G7-TOPOLOGY-ERROR'
        }]
      };
    }
  }

  /**
   * Validate basic diagram structure
   */
  private validateBasicStructure(input: DiagramTopologyInput, errors: TopologyError[]): void {
    if (!input.nodes || !Array.isArray(input.nodes)) {
      errors.push({
        code: 'G7-MISSING-NODES',
        message: 'Diagram must have nodes array'
      });
      return;
    }

    if (!input.edges || !Array.isArray(input.edges)) {
      errors.push({
        code: 'G7-MISSING-EDGES',
        message: 'Diagram must have edges array'
      });
      return;
    }

    if (input.nodes.length === 0) {
      errors.push({
        code: 'G7-EMPTY-NODES',
        message: 'Diagram must have at least one node'
      });
    }

    if (input.nodes.length > 50) {
      errors.push({
        code: 'G7-TOO-MANY-NODES',
        message: 'Diagram has too many nodes (max 50)'
      });
    }
  }

  /**
   * Validate individual nodes
   */
  private validateNodes(nodes: any[], errors: TopologyError[]): void {
    const nodeIds = new Set<string>();

    for (const node of nodes) {
      if (!node.id || typeof node.id !== 'string') {
        errors.push({
          code: 'G7-INVALID-NODE-ID',
          message: 'Node must have valid string ID'
        });
        continue;
      }

      // Check for duplicate IDs
      if (nodeIds.has(node.id)) {
        errors.push({
          code: 'G7-DUPLICATE-NODE-ID',
          message: `Duplicate node ID: ${node.id}`,
          nodeId: node.id
        });
      }
      nodeIds.add(node.id);

      // Validate node ID format
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(node.id)) {
        errors.push({
          code: 'G7-INVALID-NODE-ID-FORMAT',
          message: `Invalid node ID format: ${node.id}`,
          nodeId: node.id
        });
      }

      // Validate label
      if (!node.label || typeof node.label !== 'string' || node.label.trim().length === 0) {
        errors.push({
          code: 'G7-INVALID-NODE-LABEL',
          message: `Node ${node.id} must have non-empty label`,
          nodeId: node.id
        });
      }

      // Validate shape
      const validShapes = ['rect', 'circle', 'diamond', 'ellipse'];
      if (!validShapes.includes(node.shape)) {
        errors.push({
          code: 'G7-INVALID-NODE-SHAPE',
          message: `Node ${node.id} has invalid shape: ${node.shape}`,
          nodeId: node.id
        });
      }
    }
  }

  /**
   * Validate edges and references
   */
  private validateEdges(nodes: any[], edges: any[], errors: TopologyError[]): void {
    const nodeIds = new Set(nodes.map(n => n.id));

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];

      if (!edge.from || typeof edge.from !== 'string') {
        errors.push({
          code: 'G7-INVALID-EDGE-FROM',
          message: `Edge ${i} must have valid 'from' node ID`,
          edgeIndex: i
        });
        continue;
      }

      if (!edge.to || typeof edge.to !== 'string') {
        errors.push({
          code: 'G7-INVALID-EDGE-TO',
          message: `Edge ${i} must have valid 'to' node ID`,
          edgeIndex: i
        });
        continue;
      }

      // Check node references exist
      if (!nodeIds.has(edge.from)) {
        errors.push({
          code: 'G7-EDGE-FROM-NOT-FOUND',
          message: `Edge ${i} references non-existent node: ${edge.from}`,
          edgeIndex: i
        });
      }

      if (!nodeIds.has(edge.to)) {
        errors.push({
          code: 'G7-EDGE-TO-NOT-FOUND',
          message: `Edge ${i} references non-existent node: ${edge.to}`,
          edgeIndex: i
        });
      }

      // Check for self-loops (usually not desired in educational diagrams)
      if (edge.from === edge.to) {
        errors.push({
          code: 'G7-SELF-LOOP',
          message: `Edge ${i} creates self-loop on node: ${edge.from}`,
          edgeIndex: i
        });
      }
    }
  }

  /**
   * Validate topology based on diagram type
   */
  private validateTopology(
    nodes: any[],
    edges: any[],
    type: string,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    const nodeIds = nodes.map(n => n.id);
    const adjacencyList = this.buildAdjacencyList(nodeIds, edges);

    switch (type) {
      case 'flowchart':
        this.validateFlowchartTopology(adjacencyList, errors, warnings);
        break;
      case 'hierarchy':
        this.validateHierarchyTopology(adjacencyList, errors, warnings);
        break;
      case 'cycle':
        this.validateCycleTopology(adjacencyList, errors, warnings);
        break;
      case 'process':
        this.validateProcessTopology(adjacencyList, errors, warnings);
        break;
      case 'mind-map':
        this.validateMindMapTopology(adjacencyList, errors, warnings);
        break;
      default:
        // Generic validation for unknown types
        this.validateGenericTopology(adjacencyList, errors, warnings);
    }
  }

  /**
   * Build adjacency list representation
   */
  private buildAdjacencyList(nodeIds: string[], edges: any[]): Map<string, string[]> {
    const adj = new Map<string, string[]>();

    // Initialize all nodes
    for (const nodeId of nodeIds) {
      adj.set(nodeId, []);
    }

    // Add edges
    for (const edge of edges) {
      if (adj.has(edge.from) && adj.has(edge.to)) {
        adj.get(edge.from)!.push(edge.to);
      }
    }

    return adj;
  }

  /**
   * Validate flowchart topology
   */
  private validateFlowchartTopology(
    adj: Map<string, string[]>,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    // Should have clear start/end points
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();

    // Calculate degrees
    for (const [node, neighbors] of adj) {
      outDegree.set(node, neighbors.length);
      inDegree.set(node, 0);
    }

    for (const [node, neighbors] of adj) {
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
      }
    }

    // Check for start nodes (in-degree 0)
    const startNodes = Array.from(inDegree.entries()).filter(([_, deg]) => deg === 0);
    if (startNodes.length === 0) {
      errors.push({
        code: 'G7-NO-START-NODE',
        message: 'Flowchart should have at least one start node (no incoming edges)'
      });
    }

    // Check for end nodes (out-degree 0)
    const endNodes = Array.from(outDegree.entries()).filter(([_, deg]) => deg === 0);
    if (endNodes.length === 0) {
      warnings.push('Flowchart has no end nodes (consider adding terminal nodes)');
    }
  }

  /**
   * Validate hierarchy topology
   */
  private validateHierarchyTopology(
    adj: Map<string, string[]>,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    // Should be a tree (no cycles, single root)
    if (this.hasCycles(adj)) {
      errors.push({
        code: 'G7-HIERARCHY-CYCLES',
        message: 'Hierarchy diagrams should not contain cycles'
      });
    }

    // Check for single root
    const inDegree = new Map<string, number>();
    for (const node of adj.keys()) {
      inDegree.set(node, 0);
    }

    for (const [_, neighbors] of adj) {
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
      }
    }

    const roots = Array.from(inDegree.entries()).filter(([_, deg]) => deg === 0);
    if (roots.length === 0) {
      errors.push({
        code: 'G7-NO-ROOT',
        message: 'Hierarchy should have a root node'
      });
    } else if (roots.length > 1) {
      warnings.push('Hierarchy has multiple roots (consider connecting to single root)');
    }
  }

  /**
   * Validate cycle topology
   */
  private validateCycleTopology(
    adj: Map<string, string[]>,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    // Should form a cycle
    if (!this.hasCycles(adj)) {
      warnings.push('Cycle diagram does not contain any cycles');
    }
  }

  /**
   * Validate process topology
   */
  private validateProcessTopology(
    adj: Map<string, string[]>,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    // Similar to flowchart but should be more linear
    const inDegree = new Map<string, number>();
    for (const node of adj.keys()) {
      inDegree.set(node, 0);
    }

    for (const [_, neighbors] of adj) {
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
      }
    }

    // Check connectivity
    if (!this.isWeaklyConnected(adj)) {
      warnings.push('Process diagram has disconnected components');
    }
  }

  /**
   * Validate mind-map topology
   */
  private validateMindMapTopology(
    adj: Map<string, string[]>,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    // Should be tree-like with central node
    if (this.hasCycles(adj)) {
      warnings.push('Mind-map contains cycles (consider tree structure)');
    }
  }

  /**
   * Generic topology validation
   */
  private validateGenericTopology(
    adj: Map<string, string[]>,
    errors: TopologyError[],
    warnings: string[]
  ): void {
    // Basic connectivity check
    if (!this.isWeaklyConnected(adj)) {
      warnings.push('Diagram has disconnected components');
    }
  }

  /**
   * Check if graph has cycles using DFS
   */
  private hasCycles(adj: Map<string, string[]>): boolean {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycleDFS = (node: string): boolean => {
      visited.add(node);
      recStack.add(node);

      for (const neighbor of adj.get(node) || []) {
        if (!visited.has(neighbor)) {
          if (hasCycleDFS(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const node of adj.keys()) {
      if (!visited.has(node)) {
        if (hasCycleDFS(node)) return true;
      }
    }

    return false;
  }

  /**
   * Check if graph is weakly connected
   */
  private isWeaklyConnected(adj: Map<string, string[]>): boolean {
    if (adj.size === 0) return true;

    // Build undirected version
    const undirected = new Map<string, Set<string>>();
    for (const node of adj.keys()) {
      undirected.set(node, new Set());
    }

    for (const [node, neighbors] of adj) {
      for (const neighbor of neighbors) {
        undirected.get(node)!.add(neighbor);
        undirected.get(neighbor)!.add(node);
      }
    }

    // DFS to check connectivity
    const visited = new Set<string>();
    const start = adj.keys().next().value;

    const dfs = (node: string) => {
      visited.add(node);
      for (const neighbor of undirected.get(node) || []) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        }
      }
    };

    dfs(start);
    return visited.size === adj.size;
  }
}