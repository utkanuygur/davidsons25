#!/usr/bin/env python3
from graphviz import Digraph

# Create a new directed graph
dot = Digraph(comment='Insurly Decision Tree', format='pdf')

# Define nodes with labels and shapes
dot.node('A', 'Start', shape='circle')
dot.node('B', 'Ask: "Can you please tell me your Policy ID?"', shape='box')
dot.node('C', 'Ask: "What is the nature of your claim?\n(Car accident, theft, vandalism)"', shape='box')
dot.node('D', 'Car Accident Flow', shape='box')
dot.node('E', 'Theft Flow', shape='box')
dot.node('F', 'Vandalism Flow', shape='box')
dot.node('G', 'No Sub-flow\nPrompt: "Anything else? (or say \'done\')"', shape='box')

# Car Accident subflow nodes
dot.node('D1', 'Ask: "Was there any alcohol involved?"', shape='box')
dot.node('D2', 'Ask: "How severe was the accident?"', shape='box')
dot.node('D3', 'Ask: "Were there any injuries?"', shape='box')
dot.node('D4', 'Car Accident Info Complete\n"Anything else? (or say \'done\')"', shape='box')

# Theft subflow nodes
dot.node('E1', 'Ask: "Where did the theft occur?"', shape='box')
dot.node('E2', 'Ask: "What was stolen?"', shape='box')
dot.node('E3', 'Ask: "Have you filed a police report?"', shape='box')
dot.node('E4', 'Theft Info Complete\n"Anything else? (or say \'done\')"', shape='box')

# Vandalism subflow nodes
dot.node('F1', 'Ask: "Describe the vandalism?"', shape='box')
dot.node('F2', 'Ask: "Did you report it to authorities?"', shape='box')
dot.node('F3', 'Vandalism Info Complete\n"Anything else? (or say \'done\')"', shape='box')

# Node for additional input when claim type is unrecognized
dot.node('H', 'Wait for user response\nor "done"', shape='box')

# Finalization nodes
dot.node('I', 'Finalize Claim', shape='doublecircle')
dot.node('J', 'End Conversation', shape='circle')

# Define edges for the main flow
dot.edge('A', 'B')
dot.edge('B', 'C')
dot.edge('C', 'D', label='Includes "car"')
dot.edge('C', 'E', label='Includes "theft"')
dot.edge('C', 'F', label='Includes "vandalism"')
dot.edge('C', 'G', label='Unrecognized Type')

# Car Accident subflow edges
dot.edge('D', 'D1')
dot.edge('D1', 'D2')
dot.edge('D2', 'D3')
dot.edge('D3', 'D4')

# Theft subflow edges
dot.edge('E', 'E1')
dot.edge('E1', 'E2')
dot.edge('E2', 'E3')
dot.edge('E3', 'E4')

# Vandalism subflow edges
dot.edge('F', 'F1')
dot.edge('F1', 'F2')
dot.edge('F2', 'F3')

# Edge for unrecognized type
dot.edge('G', 'H')

# Merge all subflows to finalization
dot.edge('D4', 'I')
dot.edge('E4', 'I')
dot.edge('F3', 'I')
dot.edge('H', 'I')

# End conversation
dot.edge('I', 'J')

# Render the graph to a PDF file and open it (if supported on your system)
dot.render('insurly_decision_tree', view=True)

print("Decision tree has been generated and saved as 'insurly_decision_tree.pdf'.")
