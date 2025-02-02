#!/usr/bin/env python3
import networkx as nx
import matplotlib.pyplot as plt

# Create a directed graph
G = nx.DiGraph()

# Define nodes with labels
nodes = {
    'A': 'Start',
    'B': 'Ask: "Can you please tell me your Policy ID?"',
    'C': 'Ask: "What is the nature of your claim?\n(Car accident, theft, vandalism)"',
    'D': 'Car Accident Flow',
    'E': 'Theft Flow',
    'F': 'Vandalism Flow',
    'G': 'No Sub-flow\nPrompt: "Anything else? (or say \'done\')"',
    'D1': 'Ask: "Was there any alcohol involved?"',
    'D2': 'Ask: "How severe was the accident?"',
    'D3': 'Ask: "Were there any injuries?"',
    'D4': 'Car Accident Info Complete\n"Anything else? (or say \'done\')"',
    'E1': 'Ask: "Where did the theft occur?"',
    'E2': 'Ask: "What was stolen?"',
    'E3': 'Ask: "Have you filed a police report?"',
    'E4': 'Theft Info Complete\n"Anything else? (or say \'done\')"',
    'F1': 'Ask: "Describe the vandalism?"',
    'F2': 'Ask: "Did you report it to authorities?"',
    'F3': 'Vandalism Info Complete\n"Anything else? (or say \'done\')"',
    'H': 'Wait for user response\nor "done"',
    'I': 'Finalize Claim',
    'J': 'End Conversation'
}

# Add nodes to the graph
for node, label in nodes.items():
    G.add_node(node, label=label)

# Define edges along with optional edge labels
edges = [
    ('A', 'B', None),
    ('B', 'C', None),
    ('C', 'D', 'Includes "car"'),
    ('C', 'E', 'Includes "theft"'),
    ('C', 'F', 'Includes "vandalism"'),
    ('C', 'G', 'Unrecognized Type'),
    ('D', 'D1', None),
    ('D1', 'D2', None),
    ('D2', 'D3', None),
    ('D3', 'D4', None),
    ('E', 'E1', None),
    ('E1', 'E2', None),
    ('E2', 'E3', None),
    ('E3', 'E4', None),
    ('F', 'F1', None),
    ('F1', 'F2', None),
    ('F2', 'F3', None),
    ('G', 'H', None),
    ('D4', 'I', None),
    ('E4', 'I', None),
    ('F3', 'I', None),
    ('H', 'I', None),
    ('I', 'J', None)
]

# Add edges to the graph
for u, v, label in edges:
    if label:
        G.add_edge(u, v, label=label)
    else:
        G.add_edge(u, v)

# Manually specify positions for a hierarchical layout.
# (x, y) coordinates are in the range [0,1]. Adjust as needed.
pos = {
    'A': (0.5, 1.0),
    'B': (0.5, 0.9),
    'C': (0.5, 0.8),
    'D': (0.2, 0.7),
    'E': (0.4, 0.7),
    'F': (0.6, 0.7),
    'G': (0.8, 0.7),
    'D1': (0.2, 0.6),
    'D2': (0.2, 0.5),
    'D3': (0.2, 0.4),
    'D4': (0.2, 0.3),
    'E1': (0.4, 0.6),
    'E2': (0.4, 0.5),
    'E3': (0.4, 0.4),
    'E4': (0.4, 0.3),
    'F1': (0.6, 0.6),
    'F2': (0.6, 0.5),
    'F3': (0.6, 0.4),
    'H': (0.8, 0.6),
    'I': (0.5, 0.2),
    'J': (0.5, 0.1)
}

# Draw the nodes, labels, and edges
plt.figure(figsize=(12, 10))
nx.draw_networkx_nodes(G, pos, node_size=2000, node_color='lightblue')
nx.draw_networkx_labels(G, pos, labels=nx.get_node_attributes(G, 'label'),
                        font_size=8, font_weight='bold', verticalalignment='center')
nx.draw_networkx_edges(G, pos, arrows=True, arrowstyle='->', arrowsize=20)

# Prepare and draw edge labels (only for edges that have labels)
edge_labels = {(u, v): d['label'] for u, v, d in G.edges(data=True) if 'label' in d}
nx.draw_networkx_edge_labels(G, pos, edge_labels=edge_labels, font_color='red', font_size=8)

plt.title("Insurly Decision Tree", fontsize=14)
plt.axis('off')
plt.tight_layout()
plt.show()
